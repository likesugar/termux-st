
            (function() {
                if (window._wtaBlobCacheHooked) return;
                window._wtaBlobCacheHooked = true;
                const blobUrlMap = window.__wtaBlobMap || (window.__wtaBlobMap = new Map());
                const blobNameMap = window.__wtaBlobNameMap || (window.__wtaBlobNameMap = new Map());
                // Blob handles pin real memory and most pages never revoke. Cap the cache
                // (insertion-ordered LRU) so blob-heavy pages cannot grow it without bound.
                const BLOB_CACHE_CAP = 200;
                const blobCachePut = function(url, blob) {
                    if (blobUrlMap.has(url)) blobUrlMap.delete(url);
                    blobUrlMap.set(url, blob);
                    while (blobUrlMap.size > BLOB_CACHE_CAP) {
                        blobUrlMap.delete(blobUrlMap.keys().next().value);
                    }
                };
                const originalCreateObjectURL = URL.createObjectURL.bind(URL);
                const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
                URL.createObjectURL = function(blob) {
                    const url = originalCreateObjectURL(blob);
                    if (blob instanceof Blob) {
                        blobCachePut(url, blob);
                    }
                    return url;
                };
                URL.revokeObjectURL = function(url) {
                    setTimeout(function() { blobUrlMap.delete(url); blobNameMap.delete(url); }, 30000);
                    return originalRevokeObjectURL(url);
                };
                document.addEventListener('click', function(e) {
                    var target = e.target;
                    while (target && target.tagName !== 'A') {
                        target = target.parentElement;
                    }
                    if (!target || target.tagName !== 'A') return;
                    var href = target.href || '';
                    if (href.indexOf('blob:') !== 0 && href.indexOf('data:') !== 0) return;
                    var dl = target.getAttribute('download');
                    if (dl) blobNameMap.set(href, dl);
                }, true);

                // ---- Cross-context blob resolution ----
                // blob:null/... URLs are created in opaque-origin contexts (sandboxed
                // iframe, file:/data: document, opaque Worker). fetch() on them only
                // works inside the creating context, and the map above is per-realm —
                // so a blob URL clicked in a different frame resolves to nothing.
                // Blob objects survive structured clone, though: every hooked frame
                // answers blob queries and relays them to its own descendant frames.
                const blobSeenQueries = new Set();
                window.addEventListener('message', function(e) {
                    const d = e && e.data;
                    if (!d || d.__wta_blob_q__ !== true) return;
                    const hit = blobUrlMap.get(d.url);
                    if (hit && e.source) {
                        try { e.source.postMessage({__wta_blob_a__: true, id: d.id, url: d.url, blob: hit}, '*'); } catch (err) {}
                    }
                    if (!blobSeenQueries.has(d.id)) {
                        blobSeenQueries.add(d.id);
                        if (blobSeenQueries.size > 200) blobSeenQueries.clear();
                        const frames = document.querySelectorAll('iframe,frame');
                        for (let i = 0; i < frames.length; i++) {
                            try { if (frames[i].contentWindow) frames[i].contentWindow.postMessage(d, '*'); } catch (err) {}
                        }
                    }
                });
                window.addEventListener('message', function(e) {
                    const d = e && e.data;
                    if (!d || d.__wta_blob_a__ !== true) return;
                    const pending = window.__wtaBlobPending;
                    const cb = pending && pending[d.id];
                    if (cb) {
                        delete pending[d.id];
                        if (d.blob instanceof Blob) blobCachePut(d.url, d.blob);
                        cb(d.blob instanceof Blob ? d.blob : null);
                    }
                });
                window.__wtaQueryBlobFromFrames = function(url, timeoutMs) {
                    return new Promise(function(resolve) {
                        const pending = window.__wtaBlobPending || (window.__wtaBlobPending = {});
                        const id = 'q' + Math.random().toString(36).slice(2) + Date.now();
                        let done = false;
                        const finish = function(b) { if (!done) { done = true; delete pending[id]; resolve(b); } };
                        pending[id] = finish;
                        const msg = {__wta_blob_q__: true, id: id, url: url};
                        try { if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*'); } catch (e) {}
                        try { if (window.top && window.top !== window && window.top !== window.parent) window.top.postMessage(msg, '*'); } catch (e) {}
                        const frames = document.querySelectorAll('iframe,frame');
                        for (let i = 0; i < frames.length; i++) {
                            try { if (frames[i].contentWindow) frames[i].contentWindow.postMessage(msg, '*'); } catch (e) {}
                        }
                        setTimeout(function() { finish(null); }, timeoutMs || 1500);
                    });
                };
                window.__wtaResolveBlob = async function(url) {
                    const local = blobUrlMap.get(url);
                    if (local) return local;
                    const remote = await window.__wtaQueryBlobFromFrames(url, 1500);
                    if (remote) return remote;
                    try {
                        const response = await fetch(url);
                        return await response.blob();
                    } catch (e) {
                        return null;
                    }
                };

                // ---- Worker-created blobs ----
                // URL.createObjectURL inside a Worker lives in the worker's own global —
                // the page-side patch above never sees it, and blobs minted by opaque
                // workers come out as blob:null which the page cannot fetch either.
                // Wrap the constructor: prepend a preamble that reports every created
                // blob back through postMessage (structured clone yields a live Blob
                // handle the page can read), and filter those internal reports out of
                // the page-facing message channel.
                if (window.Worker && !window.__wtaWorkerPatched) {
                    window.__wtaWorkerPatched = true;
                    const OriginalWorker = window.Worker;
                    const workerPreamble =
                        "(function(){var _c=self.URL.createObjectURL.bind(self.URL);" +
                        "self.URL.createObjectURL=function(b){var u=_c(b);" +
                        "if(b instanceof Blob){try{self.postMessage({__wta_blob_reg__:1,url:u,blob:b});}catch(e){}}" +
                        "return u;};})();\n";
                    window.Worker = function(scriptURL, options) {
                        try {
                            // Module workers cannot importScripts; run them unpatched
                            // rather than break them (their blob URLs stay untracked).
                            if (options && options.type === 'module') {
                                return new OriginalWorker(scriptURL, options);
                            }
                            // importScripts in a bootstrap blob keeps worker creation
                            // off the synchronous-XHR path: no JS-thread stall while
                            // the script downloads. importScripts runs it in the same
                            // worker, so preamble and page script share one context.
                            var absUrl = new URL(String(scriptURL),
                                (document.baseURI || location.href)).href;
                            var wrapped = new Blob(
                                [workerPreamble, "importScripts(" + JSON.stringify(absUrl) + ");\n"],
                                {type: 'text/javascript'}
                            );
                            const w = new OriginalWorker(URL.createObjectURL(wrapped), options);
                            let userOnMessage = null;
                            const userListeners = [];
                            w.addEventListener('message', function(e) {
                                const d = e.data;
                                if (d && d.__wta_blob_reg__ === 1) {
                                    if (d.blob instanceof Blob) blobCachePut(d.url, d.blob);
                                    return;
                                }
                                if (userOnMessage) userOnMessage.call(w, e);
                                for (let i = 0; i < userListeners.length; i++) userListeners[i].call(w, e);
                            });
                            w.addEventListener = function(type, fn, opts) {
                                if (type === 'message') { userListeners.push(fn); return; }
                                OriginalWorker.prototype.addEventListener.call(w, type, fn, opts);
                            };
                            w.removeEventListener = function(type, fn, opts) {
                                if (type === 'message') {
                                    const idx = userListeners.indexOf(fn);
                                    if (idx >= 0) userListeners.splice(idx, 1);
                                    return;
                                }
                                OriginalWorker.prototype.removeEventListener.call(w, type, fn, opts);
                            };
                            Object.defineProperty(w, 'onmessage', {
                                get: function() { return userOnMessage; },
                                set: function(fn) { userOnMessage = fn; }
                            });
                            return w;
                        } catch (e) {
                            return new OriginalWorker(scriptURL, options);
                        }
                    };
                    window.Worker.prototype = OriginalWorker.prototype;
                    try { Object.setPrototypeOf(window.Worker, OriginalWorker); } catch (e) {}
                }
            })();
        
            (function() {
                if (window._downloadBridgeInjected) return;
                window._downloadBridgeInjected = true;

                console.log('[DownloadBridge] Starting injection...');
                const originalCreateElement = document.createElement.bind(document);
                
            (function() {
                if (window._wtaBlobCacheHooked) return;
                window._wtaBlobCacheHooked = true;
                const blobUrlMap = window.__wtaBlobMap || (window.__wtaBlobMap = new Map());
                const blobNameMap = window.__wtaBlobNameMap || (window.__wtaBlobNameMap = new Map());
                // Blob handles pin real memory and most pages never revoke. Cap the cache
                // (insertion-ordered LRU) so blob-heavy pages cannot grow it without bound.
                const BLOB_CACHE_CAP = 200;
                const blobCachePut = function(url, blob) {
                    if (blobUrlMap.has(url)) blobUrlMap.delete(url);
                    blobUrlMap.set(url, blob);
                    while (blobUrlMap.size > BLOB_CACHE_CAP) {
                        blobUrlMap.delete(blobUrlMap.keys().next().value);
                    }
                };
                const originalCreateObjectURL = URL.createObjectURL.bind(URL);
                const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
                URL.createObjectURL = function(blob) {
                    const url = originalCreateObjectURL(blob);
                    if (blob instanceof Blob) {
                        blobCachePut(url, blob);
                    }
                    return url;
                };
                URL.revokeObjectURL = function(url) {
                    setTimeout(function() { blobUrlMap.delete(url); blobNameMap.delete(url); }, 30000);
                    return originalRevokeObjectURL(url);
                };
                document.addEventListener('click', function(e) {
                    var target = e.target;
                    while (target && target.tagName !== 'A') {
                        target = target.parentElement;
                    }
                    if (!target || target.tagName !== 'A') return;
                    var href = target.href || '';
                    if (href.indexOf('blob:') !== 0 && href.indexOf('data:') !== 0) return;
                    var dl = target.getAttribute('download');
                    if (dl) blobNameMap.set(href, dl);
                }, true);

                // ---- Cross-context blob resolution ----
                // blob:null/... URLs are created in opaque-origin contexts (sandboxed
                // iframe, file:/data: document, opaque Worker). fetch() on them only
                // works inside the creating context, and the map above is per-realm —
                // so a blob URL clicked in a different frame resolves to nothing.
                // Blob objects survive structured clone, though: every hooked frame
                // answers blob queries and relays them to its own descendant frames.
                const blobSeenQueries = new Set();
                window.addEventListener('message', function(e) {
                    const d = e && e.data;
                    if (!d || d.__wta_blob_q__ !== true) return;
                    const hit = blobUrlMap.get(d.url);
                    if (hit && e.source) {
                        try { e.source.postMessage({__wta_blob_a__: true, id: d.id, url: d.url, blob: hit}, '*'); } catch (err) {}
                    }
                    if (!blobSeenQueries.has(d.id)) {
                        blobSeenQueries.add(d.id);
                        if (blobSeenQueries.size > 200) blobSeenQueries.clear();
                        const frames = document.querySelectorAll('iframe,frame');
                        for (let i = 0; i < frames.length; i++) {
                            try { if (frames[i].contentWindow) frames[i].contentWindow.postMessage(d, '*'); } catch (err) {}
                        }
                    }
                });
                window.addEventListener('message', function(e) {
                    const d = e && e.data;
                    if (!d || d.__wta_blob_a__ !== true) return;
                    const pending = window.__wtaBlobPending;
                    const cb = pending && pending[d.id];
                    if (cb) {
                        delete pending[d.id];
                        if (d.blob instanceof Blob) blobCachePut(d.url, d.blob);
                        cb(d.blob instanceof Blob ? d.blob : null);
                    }
                });
                window.__wtaQueryBlobFromFrames = function(url, timeoutMs) {
                    return new Promise(function(resolve) {
                        const pending = window.__wtaBlobPending || (window.__wtaBlobPending = {});
                        const id = 'q' + Math.random().toString(36).slice(2) + Date.now();
                        let done = false;
                        const finish = function(b) { if (!done) { done = true; delete pending[id]; resolve(b); } };
                        pending[id] = finish;
                        const msg = {__wta_blob_q__: true, id: id, url: url};
                        try { if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*'); } catch (e) {}
                        try { if (window.top && window.top !== window && window.top !== window.parent) window.top.postMessage(msg, '*'); } catch (e) {}
                        const frames = document.querySelectorAll('iframe,frame');
                        for (let i = 0; i < frames.length; i++) {
                            try { if (frames[i].contentWindow) frames[i].contentWindow.postMessage(msg, '*'); } catch (e) {}
                        }
                        setTimeout(function() { finish(null); }, timeoutMs || 1500);
                    });
                };
                window.__wtaResolveBlob = async function(url) {
                    const local = blobUrlMap.get(url);
                    if (local) return local;
                    const remote = await window.__wtaQueryBlobFromFrames(url, 1500);
                    if (remote) return remote;
                    try {
                        const response = await fetch(url);
                        return await response.blob();
                    } catch (e) {
                        return null;
                    }
                };

                // ---- Worker-created blobs ----
                // URL.createObjectURL inside a Worker lives in the worker's own global —
                // the page-side patch above never sees it, and blobs minted by opaque
                // workers come out as blob:null which the page cannot fetch either.
                // Wrap the constructor: prepend a preamble that reports every created
                // blob back through postMessage (structured clone yields a live Blob
                // handle the page can read), and filter those internal reports out of
                // the page-facing message channel.
                if (window.Worker && !window.__wtaWorkerPatched) {
                    window.__wtaWorkerPatched = true;
                    const OriginalWorker = window.Worker;
                    const workerPreamble =
                        "(function(){var _c=self.URL.createObjectURL.bind(self.URL);" +
                        "self.URL.createObjectURL=function(b){var u=_c(b);" +
                        "if(b instanceof Blob){try{self.postMessage({__wta_blob_reg__:1,url:u,blob:b});}catch(e){}}" +
                        "return u;};})();\n";
                    window.Worker = function(scriptURL, options) {
                        try {
                            // Module workers cannot importScripts; run them unpatched
                            // rather than break them (their blob URLs stay untracked).
                            if (options && options.type === 'module') {
                                return new OriginalWorker(scriptURL, options);
                            }
                            // importScripts in a bootstrap blob keeps worker creation
                            // off the synchronous-XHR path: no JS-thread stall while
                            // the script downloads. importScripts runs it in the same
                            // worker, so preamble and page script share one context.
                            var absUrl = new URL(String(scriptURL),
                                (document.baseURI || location.href)).href;
                            var wrapped = new Blob(
                                [workerPreamble, "importScripts(" + JSON.stringify(absUrl) + ");\n"],
                                {type: 'text/javascript'}
                            );
                            const w = new OriginalWorker(URL.createObjectURL(wrapped), options);
                            let userOnMessage = null;
                            const userListeners = [];
                            w.addEventListener('message', function(e) {
                                const d = e.data;
                                if (d && d.__wta_blob_reg__ === 1) {
                                    if (d.blob instanceof Blob) blobCachePut(d.url, d.blob);
                                    return;
                                }
                                if (userOnMessage) userOnMessage.call(w, e);
                                for (let i = 0; i < userListeners.length; i++) userListeners[i].call(w, e);
                            });
                            w.addEventListener = function(type, fn, opts) {
                                if (type === 'message') { userListeners.push(fn); return; }
                                OriginalWorker.prototype.addEventListener.call(w, type, fn, opts);
                            };
                            w.removeEventListener = function(type, fn, opts) {
                                if (type === 'message') {
                                    const idx = userListeners.indexOf(fn);
                                    if (idx >= 0) userListeners.splice(idx, 1);
                                    return;
                                }
                                OriginalWorker.prototype.removeEventListener.call(w, type, fn, opts);
                            };
                            Object.defineProperty(w, 'onmessage', {
                                get: function() { return userOnMessage; },
                                set: function(fn) { userOnMessage = fn; }
                            });
                            return w;
                        } catch (e) {
                            return new OriginalWorker(scriptURL, options);
                        }
                    };
                    window.Worker.prototype = OriginalWorker.prototype;
                    try { Object.setPrototypeOf(window.Worker, OriginalWorker); } catch (e) {}
                }
            })();
        
                const blobUrlMap = window.__wtaBlobMap || (window.__wtaBlobMap = new Map());
                document.createElement = function(tagName) {
                    const element = originalCreateElement(tagName);

                    if (tagName.toLowerCase() === 'a') {
                        const originalClick = element.click.bind(element);
                        element.click = function() {
                            const href = element.href || '';
                            const download = element.getAttribute('download');

                            console.log('[DownloadBridge] <a>.click() intercepted:', href.substring(0, 100), 'download:', download);

                            if (element.getAttribute('data-wta-bypass') === '1') {
                                return originalClick();
                            }

                            if (href.startsWith('blob:') && download) {
                                console.log('[DownloadBridge] Handling blob download programmatically');
                                handleBlobDownload(href, download);
                                return;
                            }

                            if (href.startsWith('data:') && download) {
                                console.log('[DownloadBridge] Handling data URL download programmatically');
                                handleDataUrlDownload(href, download);
                                return;
                            }

                            return originalClick();
                        };
                    }

                    return element;
                };

                document.addEventListener('click', function(e) {
                    let target = e.target;
                    while (target && target.tagName !== 'A') {
                        target = target.parentElement;
                    }

                    if (target && target.tagName === 'A') {
                        const href = target.href || '';
                        const download = target.getAttribute('download');

                        if (href.startsWith('blob:') && download) {
                            if (target.getAttribute('data-wta-bypass') === '1') return true;
                            e.preventDefault();
                            e.stopPropagation();
                            console.log('[DownloadBridge] Handling blob download from click event');
                            handleBlobDownload(href, download);
                            return false;
                        }

                        if (href.startsWith('data:') && download) {
                            e.preventDefault();
                            e.stopPropagation();
                            console.log('[DownloadBridge] Handling data URL download from click event');
                            handleDataUrlDownload(href, download);
                            return false;
                        }
                    }
                }, true);

                // window.open(blobUrl) bypasses click interception entirely. Route it
                // through the download pipeline when the blob is resolvable; fall back
                // to the original open so unresolvable URLs keep their preview chance.
                const originalWindowOpen = window.open;
                if (originalWindowOpen) {
                    window.open = function(url, target, features) {
                        if (typeof url === 'string' &&
                            (url.indexOf('blob:') === 0 || url.indexOf('data:') === 0)) {
                            (async function() {
                                if (url.indexOf('data:') === 0) {
                                    handleDataUrlDownload(url, '');
                                    return;
                                }
                                const blob = await window.__wtaResolveBlob(url);
                                if (blob) {
                                    handleBlobDownload(url, '');
                                } else {
                                    try { originalWindowOpen.call(window, url, target, features); } catch (e) {}
                                }
                            })();
                            return null;
                        }
                        return originalWindowOpen.apply(window, arguments);
                    };
                }

                const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024;
                const CHUNK_SIZE = 512 * 1024;
                function shouldInterceptBlob(blob) {
                    var scope = (typeof window.__wta_blob_intercept_scope__ === 'string')
                        ? window.__wta_blob_intercept_scope__ : 'ALL';
                    if (scope === 'ALL') return true;
                    var threshold = (typeof window.__wta_blob_intercept_threshold_bytes__ === 'number')
                        ? window.__wta_blob_intercept_threshold_bytes__ : 0;
                    return !!(blob && typeof blob.size === 'number' && blob.size > threshold);
                }
                async function handleBlobDownload(blobUrl, filename) {
                    try {
                        console.log('[DownloadBridge] handleBlobDownload:', blobUrl, filename);

                        if (window.AndroidDownload && window.AndroidDownload.showToast) {
                            window.AndroidDownload.showToast('正在准备下载…' + filename);
                        }

                        let blob = await window.__wtaResolveBlob(blobUrl);

                        if (!blob) {
                            console.error('[DownloadBridge] Blob unresolvable (map miss, no frame answer, fetch failed)');
                            alert('无法获取文件数据');
                            return;
                        }

                        console.log('[DownloadBridge] Blob obtained, type:', blob.type, 'size:', blob.size);

                        if (!shouldInterceptBlob(blob)) {
                            console.log('[DownloadBridge] Below intercept threshold, deferring to native download');
                            try {
                                var a = document.createElement('a');
                                a.setAttribute('data-wta-bypass', '1');
                                a.href = blobUrl;
                                a.download = filename || '';
                                a.style.display = 'none';
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                            } catch (e) {
                                console.warn('[DownloadBridge] Native fallback failed', e);
                            }
                            return;
                        }

                        const mimeType = blob.type || getMimeTypeFromFilename(filename) || 'application/octet-stream';

                        if (blob.size <= LARGE_FILE_THRESHOLD) {
                            await processSmallBlob(blob, filename, mimeType);
                        } else {
                            await processLargeBlobInChunks(blob, filename, mimeType);
                        }
                    } catch (error) {
                        console.error('[DownloadBridge] Blob download error:', error);
                        alert('下载失败：' + error.message);
                    }
                }

                async function processSmallBlob(blob, filename, mimeType) {
                    return new Promise((resolve, reject) => {
                        const reader = new FileReader();

                        reader.onloadend = function() {
                            try {
                                const base64Data = reader.result.split(',')[1];
                                console.log('[DownloadBridge] Sending to native, base64 length:', base64Data ? base64Data.length : 0);

                                if (window.AndroidDownload && window.AndroidDownload.saveBase64File) {
                                    window.AndroidDownload.saveBase64File(base64Data, filename, mimeType);
                                    resolve();
                                } else {
                                    console.error('[DownloadBridge] AndroidDownload bridge not available');
                                    alert('下载功能不可用');
                                    reject(new Error('Bridge not available'));
                                }
                            } catch (e) {
                                console.error('[DownloadBridge] Error processing blob:', e);
                                alert('处理文件失败：' + e.message);
                                reject(e);
                            }
                        };

                        reader.onerror = function() {
                            console.error('[DownloadBridge] FileReader error');
                            alert('读取文件失败');
                            reject(new Error('FileReader error'));
                        };

                        reader.readAsDataURL(blob);
                    });
                }

                async function processLargeBlobInChunks(blob, filename, mimeType) {
                    console.log('[DownloadBridge] Processing large file in chunks:', blob.size, 'bytes');

                    if (window.AndroidDownload && window.AndroidDownload.startChunkedDownload) {
                        const downloadId = window.AndroidDownload.startChunkedDownload(filename, mimeType, blob.size);

                        let offset = 0;
                        const totalChunks = Math.ceil(blob.size / CHUNK_SIZE);
                        let currentChunk = 0;

                        function uint8ToBase64(uint8Array) {
                            const SUB_BATCH = 8192;
                            const parts = [];
                            for (let i = 0; i < uint8Array.length; i += SUB_BATCH) {
                                parts.push(String.fromCharCode.apply(null, uint8Array.subarray(i, i + SUB_BATCH)));
                            }
                            return btoa(parts.join(''));
                        }

                        const processNextChunk = () => {
                            if (offset >= blob.size) {
                                window.AndroidDownload.finishChunkedDownload(downloadId);
                                console.log('[DownloadBridge] Large file download complete');
                                return;
                            }

                            const chunk = blob.slice(offset, offset + CHUNK_SIZE);
                            chunk.arrayBuffer().then(function(arrayBuffer) {
                                const bytes = new Uint8Array(arrayBuffer);
                                const base64Chunk = uint8ToBase64(bytes);

                                window.AndroidDownload.appendChunk(downloadId, base64Chunk, currentChunk, totalChunks);

                                offset += CHUNK_SIZE;
                                currentChunk++;

                                setTimeout(processNextChunk, 0);
                            });
                        };

                        processNextChunk();
                    } else {
                        console.warn('[DownloadBridge] Chunked download not supported, falling back to regular processing');
                        await processSmallBlob(blob, filename, mimeType);
                    }
                }

                function handleDataUrlDownload(dataUrl, filename) {
                    try {
                        console.log('[DownloadBridge] handleDataUrlDownload:', filename);

                        const parts = dataUrl.split(',');
                        const meta = parts[0];
                        const base64Data = parts[1];

                        const mimeMatch = meta.match(/data:([^;]+)/);
                        const mimeType = mimeMatch ? mimeMatch[1] : getMimeTypeFromFilename(filename) || 'application/octet-stream';

                        if (window.AndroidDownload && window.AndroidDownload.saveBase64File) {
                            window.AndroidDownload.saveBase64File(base64Data, filename, mimeType);
                        } else {
                            console.error('[DownloadBridge] AndroidDownload bridge not available');
                            alert('下载功能不可用');
                        }
                    } catch (error) {
                        console.error('[DownloadBridge] Data URL download error:', error);
                        alert('下载失败：' + error.message);
                    }
                }

                function getMimeTypeFromFilename(filename) {
                    const ext = filename.split('.').pop().toLowerCase();
                    const mimeTypes = {
                        'json': 'application/json',
                        'txt': 'text/plain',
                        'html': 'text/html',
                        'htm': 'text/html',
                        'css': 'text/css',
                        'js': 'application/javascript',
                        'xml': 'application/xml',
                        'csv': 'text/csv',
                        'pdf': 'application/pdf',
                        'zip': 'application/zip',
                        'png': 'image/png',
                        'jpg': 'image/jpeg',
                        'jpeg': 'image/jpeg',
                        'gif': 'image/gif',
                        'webp': 'image/webp',
                        'svg': 'image/svg+xml',
                        'mp3': 'audio/mpeg',
                        'mp4': 'video/mp4',
                        'webm': 'video/webm'
                    };
                    return mimeTypes[ext] || null;
                }

                window.nativeDownload = function(data, filename, mimeType) {
                    mimeType = mimeType || getMimeTypeFromFilename(filename) || 'application/octet-stream';

                    console.log('[DownloadBridge] nativeDownload called:', filename, mimeType);

                    if (typeof data === 'string') {
                        const base64 = btoa(unescape(encodeURIComponent(data)));
                        if (window.AndroidDownload && window.AndroidDownload.saveBase64File) {
                            window.AndroidDownload.saveBase64File(base64, filename, mimeType);
                        }
                    } else if (data instanceof Blob) {
                        const reader = new FileReader();
                        reader.onloadend = function() {
                            const base64Data = reader.result.split(',')[1];
                            if (window.AndroidDownload && window.AndroidDownload.saveBase64File) {
                                window.AndroidDownload.saveBase64File(base64Data, filename, mimeType);
                            }
                        };
                        reader.readAsDataURL(data);
                    } else if (data instanceof ArrayBuffer) {
                        const bytes = new Uint8Array(data);
                        let binary = '';
                        for (let i = 0; i < bytes.byteLength; i++) {
                            binary += String.fromCharCode(bytes[i]);
                        }
                        const base64 = btoa(binary);
                        if (window.AndroidDownload && window.AndroidDownload.saveBase64File) {
                            window.AndroidDownload.saveBase64File(base64, filename, mimeType);
                        }
                    }
                };

                window.nativeDownloadJSON = function(obj, filename) {
                    const json = JSON.stringify(obj, null, 2);
                    window.nativeDownload(json, filename || 'data.json', 'application/json');
                };

                window.nativeDownloadText = function(text, filename) {
                    window.nativeDownload(text, filename || 'text.txt', 'text/plain');
                };

                window.isNativeDownloadAvailable = function() {
                    return !!(window.AndroidDownload && window.AndroidDownload.saveBase64File);
                };

                console.log('[DownloadBridge] Injection complete, bridge available:', window.isNativeDownloadAvailable());
            })();
        