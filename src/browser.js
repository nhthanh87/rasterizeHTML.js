var browser = (function (util, proxies, ayepromise, theWindow) {
    "use strict";

    var module = {};

    var createHiddenElement = function (doc, tagName, width, height) {
        var element = doc.createElement(tagName);
        // 'display: none' doesn't cut it, as browsers seem to be lazy loading CSS
        element.style.visibility = "hidden";
        element.style.width = width + "px";
        element.style.height = height + "px";
        element.style.position = "absolute";
        element.style.top = (-10000 - height) + "px";
        element.style.left = (-10000 - width) + "px";
        // We need to add the element to the document so that its content gets loaded
        doc.getElementsByTagName("body")[0].appendChild(element);
        return element;
    };

    module.executeJavascript = function (doc, options) {
        var iframe = createHiddenElement(theWindow.document, "iframe", options.width, options.height),
            html = doc.documentElement.outerHTML,
            iframeErrorsMessages = [],
            defer = ayepromise.defer(),
            timeout = options.executeJsTimeout || 0;

        var doResolve = function () {
            var doc = iframe.contentDocument;
            theWindow.document.getElementsByTagName("body")[0].removeChild(iframe);
            defer.resolve({
                document: doc,
                errors: iframeErrorsMessages
            });
        };

        var waitForJavaScriptToRun = function () {
            var d = ayepromise.defer();
            if (timeout > 0) {
                setTimeout(d.resolve, timeout);
            } else {
                d.resolve();
            }
            return d.promise;
        };

        iframe.onload = function () {
            waitForJavaScriptToRun()
                .then(finishNotifyXhrProxy.waitForRequestsToFinish)
                .then(doResolve);
        };

        var xhr = iframe.contentWindow.XMLHttpRequest,
            finishNotifyXhrProxy = proxies.finishNotifyingXhr(xhr),
            baseUrlXhrProxy = proxies.baseUrlRespectingXhr(finishNotifyXhrProxy, options.baseUrl);

        iframe.contentDocument.open();
        iframe.contentWindow.XMLHttpRequest = baseUrlXhrProxy;
        iframe.contentWindow.Image = proxies.baseUrlRespectingImage(iframe.contentWindow.Image, options.baseUrl);
        iframe.contentWindow.onerror = function (msg) {
            iframeErrorsMessages.push({
                resourceType: "scriptExecution",
                msg: msg
            });
        };

        iframe.contentDocument.write('<!DOCTYPE html>');
        iframe.contentDocument.write(html);
        iframe.contentDocument.close();

        return defer.promise;
    };

    var createHiddenSandboxedIFrame = function (doc, width, height) {
        var iframe = doc.createElement('iframe');
        iframe.style.width = width + "px";
        iframe.style.height = height + "px";
        // 'display: none' doesn't cut it, as browsers seem to be lazy loading content
        iframe.style.visibility = "hidden";
        iframe.style.position = "absolute";
        iframe.style.top = (-10000 - height) + "px";
        iframe.style.left = (-10000 - width) + "px";
        // Don't execute JS, all we need from sandboxing is access to the iframe's document
        iframe.sandbox = 'allow-same-origin';
        return iframe;
    };

    var createIframeWithSizeAtZoomLevel1 = function (width, height, zoom) {
        var scaledViewportWidth = Math.floor(width / zoom),
            scaledViewportHeight = Math.floor(height / zoom);

        return createHiddenSandboxedIFrame(theWindow.document, scaledViewportWidth, scaledViewportHeight);
    };

    var calculateZoomedContentSizeAndRoundUp = function (actualViewport, requestedWidth, requestedHeight, zoom) {
        return {
            width: Math.max(actualViewport.width * zoom, requestedWidth),
            height: Math.max(actualViewport.height * zoom, requestedHeight)
        };
    };

    var calculateContentSize = function (doc, selector, requestedWidth, requestedHeight, zoom) {
            // clientWidth/clientHeight needed for PhantomJS
        var actualViewportWidth = Math.max(doc.documentElement.scrollWidth, doc.body.clientWidth),
            actualViewportHeight = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight, doc.body.clientHeight),
            top, left, originalWidth, originalHeight, rootFontSize,
            element, rect, contentSize;

        if (selector) {
            element = doc.querySelector(selector);

            if (!element) {
                throw {
                    message: "Clipping selector not found"
                };
            }

            rect = element.getBoundingClientRect();

            top = rect.top;
            left = rect.left;
            originalWidth = rect.width;
            originalHeight = rect.height;
        } else {
            top = 0;
            left = 0;
            originalWidth = actualViewportWidth;
            originalHeight = actualViewportHeight;
        }

        contentSize = calculateZoomedContentSizeAndRoundUp({
                width: originalWidth,
                height: originalHeight
            },
            requestedWidth,
            requestedHeight,
            zoom);

        rootFontSize = theWindow.getComputedStyle(doc.documentElement).fontSize;

        return {
            left: left,
            top: top,
            width: contentSize.width,
            height: contentSize.height,
            viewportWidth: actualViewportWidth,
            viewportHeight: actualViewportHeight,

            rootFontSize: rootFontSize
        };
    };

    module.calculateDocumentContentSize = function (doc, options) {
        var html = doc.documentElement.outerHTML,
            defer = ayepromise.defer(),
            zoom = options.zoom || 1,
            iframe;


        iframe = createIframeWithSizeAtZoomLevel1(options.width, options.height, zoom);
        // We need to add the element to the document so that its content gets loaded
        theWindow.document.getElementsByTagName("body")[0].appendChild(iframe);

        iframe.onload = function () {
            var doc = iframe.contentDocument,
                size;

            try {
                size = calculateContentSize(doc, options.clip, options.width, options.height, zoom);

                defer.resolve(size);
            } catch (e) {
                defer.reject(e);
            } finally {
                theWindow.document.getElementsByTagName("body")[0].removeChild(iframe);
            }
        };

        // srcdoc doesn't work in PhantomJS yet
        iframe.contentDocument.open();
        iframe.contentDocument.write('<!DOCTYPE html>');
        iframe.contentDocument.write(html);
        iframe.contentDocument.close();

        return defer.promise;
    };

    var addHTMLTagAttributes = function (doc, html) {
        var attributeMatch = /<html((?:\s+[^>]*)?)>/im.exec(html),
            helperDoc = theWindow.document.implementation.createHTMLDocument(''),
            htmlTagSubstitute,
            i, elementSubstitute, attribute;

        if (!attributeMatch) {
            return;
        }

        htmlTagSubstitute = '<div' + attributeMatch[1] + '></div>';
        helperDoc.documentElement.innerHTML = htmlTagSubstitute;
        elementSubstitute = helperDoc.querySelector('div');

        for (i = 0; i < elementSubstitute.attributes.length; i++) {
            attribute = elementSubstitute.attributes[i];
            doc.documentElement.setAttribute(attribute.name, attribute.value);
        }
    };

    module.parseHTML = function (html) {
        // We should be using the DOMParser, but it is not supported in older browsers
        var doc = theWindow.document.implementation.createHTMLDocument('');
        doc.documentElement.innerHTML = html;

        addHTMLTagAttributes(doc, html);
        return doc;
    };

    var isParseError = function (parsedDocument) {
        // http://stackoverflow.com/questions/11563554/how-do-i-detect-xml-parsing-errors-when-using-javascripts-domparser-in-a-cross
        var p = new DOMParser(),
            errorneousParse = p.parseFromString('<', 'text/xml'),
            parsererrorNS = errorneousParse.getElementsByTagName("parsererror")[0].namespaceURI;

        if (parsererrorNS === 'http://www.w3.org/1999/xhtml') {
            // In PhantomJS the parseerror element doesn't seem to have a special namespace, so we are just guessing here :(
            return parsedDocument.getElementsByTagName("parsererror").length > 0;
        }

        return parsedDocument.getElementsByTagNameNS(parsererrorNS, 'parsererror').length > 0;
    };

    var failOnParseError = function (doc) {
        if (doc === null || isParseError(doc)) {
            throw {
                message: "Invalid source"
            };
        }
    };

    module.validateXHTML = function (xhtml) {
        var p = new DOMParser(),
            doc = p.parseFromString(xhtml, "application/xml");

        failOnParseError(doc);
    };

    var lastCacheDate = null;

    var getUncachableURL = function (url, cache) {
        if (cache === false || cache === 'none' || cache === 'repeated') {
            if (lastCacheDate === null || cache !== 'repeated') {
                lastCacheDate = Date.now();
            }
            return url + "?_=" + lastCacheDate;
        } else {
            return url;
        }
    };

    var doDocumentLoad = function (url, options) {
        var ajaxRequest = new window.XMLHttpRequest(),
            joinedUrl = util.joinUrl(options.baseUrl, url),
            augmentedUrl = getUncachableURL(joinedUrl, options.cache),
            defer = ayepromise.defer(),
            doReject = function () {
                defer.reject({message: "Unable to load page"});
            };

        ajaxRequest.addEventListener("load", function () {
            if (ajaxRequest.status === 200 || ajaxRequest.status === 0) {
                defer.resolve(ajaxRequest.responseXML);
            } else {
                doReject();
            }
        }, false);

        ajaxRequest.addEventListener("error", function () {
            doReject();
        }, false);

        try {
            ajaxRequest.open('GET', augmentedUrl, true);
            ajaxRequest.responseType = "document";
            ajaxRequest.send(null);
        } catch (err) {
            doReject();
        }

        return defer.promise;
    };

    module.loadDocument = function (url, options) {
        return doDocumentLoad(url, options)
            .then(function (doc) {
                failOnParseError(doc);

                return doc;
            });
    };

    return module;
}(util, proxies, ayepromise, window));
