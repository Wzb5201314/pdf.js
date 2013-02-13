/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */
/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* globals CanvasGraphics, error, globalScope, InvalidPDFException, log,
           MissingPDFException, PasswordException, PDFDocument, PDFJS, Promise,
           Stream, UnknownErrorException, warn */

'use strict';

var NetworkPdf = (function NetworkPdfClosure() {

  var BLOCK_SIZE = 1024;

  function loadPdf(begin, end, successCb, loadMoreFn) {
    PDFJS.getPdf(
      {
        range: {
          begin: normalizeRangeBegin.call(this, begin),
          end: normalizeRangeEnd.call(this, end)
        },
        url: this.pdfUrl,
        progress: networkPdfProgress.bind(this),
        error: networkPdfError.bind(this),
        headers: this.httpHeaders
      },
      function getPdfLoad(data) {
        var chunkBegin = data.context.range.begin;
        this.stream.onReceiveData(data.chunk, chunkBegin);
        var range;
        // FIXME(mack): for xref's it will not come here until the second
        // request has been made since the first request will be to get
        // the data that will be send to successCb, while the second request
        // will be made after successCb fails; this could be optimized by
        // making it exec the loadMoreData after the first request, before
        // the second request
        if (loadMoreFn && (range = loadMoreFn(data))) {
          loadPdf.call(this, range.begin, range.end, successCb, loadMoreFn);
        } else {
          successCb(data);
        }
      }.bind(this)
    );
  }

  function normalizeRangeBegin(begin) {
    return begin - begin % BLOCK_SIZE;
  }

  function normalizeRangeEnd(end) {
    if (end % BLOCK_SIZE === 0) {
      return end;
    }
    var blockEnd = end + BLOCK_SIZE - (end % BLOCK_SIZE);
    return Math.min(this.pdfLength, blockEnd);
  }

  function networkPdfProgress(evt) {
    this.msgHandler.send('DocProgress', {
      loaded: evt.loaded,
      total: evt.lengthComputable ? evt.total : void(0)
    });
  }

  function networkPdfError(evt) {
    if (evt.target.status == 404) {
      var exception = new MissingPDFException(
          'Missing PDF "' + this.pdfUrl + '".');
      this.msgHandler.send('MissingPDF', {
        exception: exception
      });
    } else {
      this.msgHandler.send('DocError', 'Unexpected server response (' +
          evt.target.status + ') while retrieving PDF "' +
          this.pdfUrl + '".');
    }
  }

  // FIXME(mack): still need to figure out if these checks are correct
  // TODO(mack): Use this to optimize request sizes for all objs, not just xrefs
  function loadMoreFn(data) {
    // FIXME(mack): Clean up how we access state of xref
    var xref = this.pdfModel.xref;
    if (xref.currXRefType !== 'table' && xref.currXRefType !== 'stream') {
      return undefined;
    }

    var regex;
    if (xref.currXRefType === 'table') {
      regex = new RegExp('startxref');
    } else {
      regex = new RegExp('endobj');
    }

    // FIXME(mack): the search chunk needs to also include part of
    // previous chunk
    var chunkStr = bytesToString(new Uint8Array(data.chunk));
    var missingEndToken = !regex.exec(chunkStr);
    var chunkEnd = data.context.range.begin + data.chunk.byteLength;
    var prevChunkSize = data.chunk.byteLength;

    if (chunkEnd < data.length && missingEndToken) {
      return {
        begin: chunkEnd,
        end: chunkEnd + 2 * prevChunkSize
      };
    }
  }

  function NetworkPdf(source, pdfLength, msgHandler) {
    this.pdfUrl = source.url;
    this.httpHeaders = source.httpHeaders;
    this.msgHandler = msgHandler;
    this.pdfLength = pdfLength;
    this.stream = new ChunkedStream(pdfLength, BLOCK_SIZE);
    this.pdfModel = new PDFDocument(this.stream, source.password);
  }

  NetworkPdf.prototype = {
    process: function networkPdfProcess(processor) {
      try {
        processor(this.pdfModel);
      } catch(ex) {
        if (!(ex instanceof MissingDataError)) {
          throw ex;
        }

        loadPdf.call(this,
          ex.begin,
          ex.end,
          function doneCb() {
            this.process(processor);
          }.bind(this),
          loadMoreFn.bind(this)
        );
      }
    }
  };

  return NetworkPdf;
})();


function MessageHandler(name, comObj) {
  this.name = name;
  this.comObj = comObj;
  this.callbackIndex = 1;
  var callbacks = this.callbacks = {};
  var ah = this.actionHandler = {};

  ah['console_log'] = [function ahConsoleLog(data) {
    log.apply(null, data);
  }];
  // If there's no console available, console_error in the
  // action handler will do nothing.
  if ('console' in globalScope) {
    ah['console_error'] = [function ahConsoleError(data) {
      globalScope['console'].error.apply(null, data);
    }];
  } else {
    ah['console_error'] = [function ahConsoleError(data) {
      log.apply(null, data);
    }];
  }
  ah['_warn'] = [function ah_Warn(data) {
    warn(data);
  }];

  comObj.onmessage = function messageHandlerComObjOnMessage(event) {

    var handler;

    var data = event.data;
    if (data.isReply) {
      var callbackId = data.callbackId;
      if (data.callbackId in callbacks) {
        var callback = callbacks[callbackId];
        delete callbacks[callbackId];
        handler = callback.bind(undefined, data.data);
      } else {
        error('Cannot resolve callback ' + callbackId);
      }
    } else if (data.action in ah) {
      var action = ah[data.action];
      if (data.callbackId) {
        var promise = new Promise();
        promise.then(function(resolvedData) {
          comObj.postMessage({
            isReply: true,
            callbackId: data.callbackId,
            data: resolvedData
          });
        });
        handler = action[0].bind(action[1], data.data, promise);
      } else {
        handler = action[0].bind(action[1], data.data);
      }
    } else {
      error('Unkown action from worker: ' + data.action);
    }

    if (!handler) {
      return;
    }

    handler();
  };
}

MessageHandler.prototype = {
  on: function messageHandlerOn(actionName, handler, scope) {
    var ah = this.actionHandler;
    if (ah[actionName]) {
      error('There is already an actionName called "' + actionName + '"');
    }
    ah[actionName] = [handler, scope];
  },
  /**
   * Sends a message to the comObj to invoke the action with the supplied data.
   * @param {String} actionName Action to call.
   * @param {JSON} data JSON data to send.
   * @param {function} [callback] Optional callback that will handle a reply.
   */
  send: function messageHandlerSend(actionName, data, callback) {
    var message = {
      action: actionName,
      data: data
    };
    if (callback) {
      var callbackId = this.callbackIndex++;
      this.callbacks[callbackId] = callback;
      message.callbackId = callbackId;
    }
    this.comObj.postMessage(message);
  }
};

var WorkerMessageHandler = {
  setup: function wphSetup(handler) {
    var networkPdf;

    function loadDocument(pdfModel) {
      // Create only the model of the PDFDoc, which is enough for
      // processing the content of the pdf.
      try {
        pdfModel.init_();
      } catch (e) {

        if (e instanceof MissingDataError) {
          throw e;
        }

        if (e instanceof PasswordException) {
          if (e.code === 'needpassword') {
            handler.send('NeedPassword', {
              exception: e
            });
          } else if (e.code === 'incorrectpassword') {
            handler.send('IncorrectPassword', {
              exception: e
            });
          }

          return;
        } else if (e instanceof InvalidPDFException) {
          handler.send('InvalidPDF', {
            exception: e
          });

          return;
        } else if (e instanceof MissingPDFException) {
          handler.send('MissingPDF', {
            exception: e
          });

          return;
        } else {
          handler.send('UnknownError', {
            exception: new UnknownErrorException(e.message, e.toString())
          });

          return;
        }
      }
    }

    handler.on('test', function wphSetupTest(data) {
      // check if Uint8Array can be sent to worker
      if (!(data instanceof Uint8Array)) {
        handler.send('test', false);
        return;
      }
      // check if the response property is supported by xhr
      var xhr = new XMLHttpRequest();
      if (!('response' in xhr || 'mozResponse' in xhr ||
          'responseArrayBuffer' in xhr || 'mozResponseArrayBuffer' in xhr)) {
        handler.send('test', false);
        return;
      }
      handler.send('test', true);
    });

    handler.on('GetDocRequest', function wphSetupDoc(data) {
      var source = data.source;
      if (source.data) {
        // the data is array, instantiating directly from it
        // FIXME(mack): broke loadDocument for this flow
        var doc = loadDocument(source.data, source);
        handler.send('GetDoc', {pdfInfo: doc});
        return;
      }

      PDFJS.getPdf(
        {
          range: { begin: 0, end: 1 },
          url: source.url,
          headers: source.httpHeaders
        },
        function(data) {
          networkPdf = new NetworkPdf(source, data.length, handler);
          networkPdf.process(function(pdfModel) {
            loadDocument(pdfModel);
            var numPages = pdfModel.numPages;
            var fingerprint = pdfModel.getFingerprint;
            var outline = pdfModel.catalog.documentOutline;
            var info = pdfModel.getDocumentInfo;
            var metadata = pdfModel.catalog.metadata;
            var encrypted = !!pdfModel.xref.encrypt;
            doc = {
              numPages: numPages,
              fingerprint: fingerprint,
              outline: outline,
              info: info,
              metadata: metadata,
              encrypted: encrypted
            };
            handler.send('GetDoc', { pdfInfo: doc });
          });
        }
      );
    });

    handler.on('GetPageRequest', function wphSetupGetPage(data) {
      networkPdf.process(function(pdfModel) {
        var pageNumber = data.pageIndex + 1;
        var pdfPage = pdfModel.getPage(pageNumber);
        var encrypt = pdfModel.xref.encrypt;
        var page = {
          pageIndex: data.pageIndex,
          rotate: pdfPage.rotate,
          ref: pdfPage.ref,
          view: pdfPage.view,
          disableTextLayer: encrypt ? encrypt.disableTextLayer : false
        };
        handler.send('GetPage', { pageInfo: page });
      });
    });

    handler.on('GetDestinationsRequest', function wphSetupGetDestinations() {
      networkPdf.process(function(pdfModel) {
        var destinations = pdfModel.catalog.destinations;
        handler.send('GetDestinations', { destinations: destinations });
      });
    });

    // FIXME(mack): make work w/ MissingDataError
    handler.on('GetData', function wphSetupGetData(data, promise) {
      promise.resolve(pdfModel.stream.bytes);
    });

    handler.on('GetAnnotationsRequest', function wphSetupGetAnnotations(data) {
      networkPdf.process(function(pdfModel) {
        var pdfPage = pdfModel.getPage(data.pageIndex + 1);
        var annotations = pdfPage.getAnnotations();
        handler.send('GetAnnotations', {
          pageIndex: data.pageIndex,
          annotations: annotations
        });
      });
    });

    handler.on('RenderPageRequest', function wphSetupRenderPage(data) {
      networkPdf.process(function(pdfModel) {

        var pageNum = data.pageIndex + 1;

        // The following code does quite the same as
        // Page.prototype.startRendering, but stops at one point and sends the
        // result back to the main thread.
        var gfx = new CanvasGraphics(null);

        var start = Date.now();

        var dependency = [];
        var operatorList = null;
        try {
          var page = pdfModel.getPage(pageNum);
          // Pre compile the pdf page and fetch the fonts/images.
          operatorList = page.getOperatorList(handler, dependency);

          log('page=%d - getOperatorList: time=%dms, len=%d', pageNum,
                                  Date.now() - start, operatorList.fnArray.length);

          // Filter the dependecies for fonts.
          var fonts = {};
          for (var i = 0, ii = dependency.length; i < ii; i++) {
            var dep = dependency[i];
            if (dep.indexOf('g_font_') === 0) {
              fonts[dep] = true;
            }
          }
          handler.send('RenderPage', {
            pageIndex: data.pageIndex,
            operatorList: operatorList,
            depFonts: Object.keys(fonts)
          });
        } catch (e) {
          var minimumStackMessage =
              'worker.js: while trying to getPage() and getOperatorList()';

          if (e instanceof MissingDataError) {
            throw e;
          }

          var wrappedException;

          // Turn the error into an obj that can be serialized
          if (typeof e === 'string') {
            wrappedException = {
              message: e,
              stack: minimumStackMessage
            };
          } else if (typeof e === 'object') {
            wrappedException = {
              message: e.message || e.toString(),
              stack: e.stack || minimumStackMessage
            };
          } else {
            wrappedException = {
              message: 'Unknown exception type: ' + (typeof e),
              stack: minimumStackMessage
            };
          }

          handler.send('PageError', {
            pageNum: pageNum,
            error: wrappedException
          });
          return;
        }
      });
    }, this);

    // FIXME(mack): make work w/ MissingDataError
    handler.on('GetTextContent', function wphExtractText(data, promise) {
      var pageNum = data.pageIndex + 1;
      var start = Date.now();

      var textContent = '';
      try {
        var page = pdfModel.getPage(pageNum);
        textContent = page.extractTextContent();
        promise.resolve(textContent);
      } catch (e) {
        // Skip errored pages
        promise.reject(e);
      }

      log('text indexing: page=%d - time=%dms',
                      pageNum, Date.now() - start);
    });
  }
};

var consoleTimer = {};

var workerConsole = {
  log: function log() {
    var args = Array.prototype.slice.call(arguments);
    globalScope.postMessage({
      action: 'console_log',
      data: args
    });
  },

  error: function error() {
    var args = Array.prototype.slice.call(arguments);
    globalScope.postMessage({
      action: 'console_error',
      data: args
    });
    throw 'pdf.js execution error';
  },

  time: function time(name) {
    consoleTimer[name] = Date.now();
  },

  timeEnd: function timeEnd(name) {
    var time = consoleTimer[name];
    if (!time) {
      error('Unkown timer name ' + name);
    }
    this.log('Timer:', name, Date.now() - time);
  }
};

// Worker thread?
if (typeof window === 'undefined') {
  globalScope.console = workerConsole;

  // Add a logger so we can pass warnings on to the main thread, errors will
  // throw an exception which will be forwarded on automatically.
  PDFJS.LogManager.addLogger({
    warn: function(msg) {
      globalScope.postMessage({
        action: '_warn',
        data: msg
      });
    }
  });

  var handler = new MessageHandler('worker_processor', this);
  WorkerMessageHandler.setup(handler);
}
