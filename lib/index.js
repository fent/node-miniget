const http        = require('http');
const https       = require('https');
const urlParse    = require('url').parse;
const PassThrough = require('stream').PassThrough;


const httpLibs = { 'http:': http, 'https:': https };
const redirectCodes = { 301: true, 302: true, 303: true, 307: true };
const defaults = {
  maxRedirects: 2,
  maxRetries: 2,
  backoff: { inc: 100, max: 10000 },
  highWaterMark: null,
  transform: null,
};

/**
* @param {String} url
* @param {!Object} options
* @param {!Function(Error, http.IncomingMessage, String)} callback
* @return {stream.Readable}
*/
module.exports = (url, options, callback) => {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  } else if (!options) {
    options = {};
  }
  options = Object.assign({}, defaults, options);
  const stream = new PassThrough({ highWaterMark: options.highWaterMark });
  let myreq, myres;
  let aborted = false;
  let redirects = 0;
  let retries = 0;

  function onError(err) {
    if (callback) {
      callback(err);
    } else {
      stream.emit('error', err);
    }
  }

  function onRequestError(err, statusCode) {
    if (!aborted && (!statusCode || err.message === 'ENOTFOUND') &&
      retries++ < options.maxRetries) {
      let ms = Math.min(retries * options.backoff.inc, options.backoff.max);
      setTimeout(doDownload, ms);
      stream.emit('retry', retries, err);
    } else {
      onError(err);
    }
  }

  function doDownload() {
    if (aborted) { return; }
    let parsed = urlParse(url);
    let httpLib = httpLibs[parsed.protocol];
    if (!httpLib) {
      onError(new Error('Invalid URL: ' + url));
      return stream;
    }

    Object.assign(parsed, options);
    for (let key in defaults) {
      delete parsed[key];
    }
    if (options.transform) {
      let transform = options.transform;
      parsed = transform(parsed);
    }

    myreq = httpLib.get(parsed, (res) => {
      if (redirectCodes[res.statusCode] === true) {
        if (redirects++ >= options.maxRedirects) {
          onError(new Error('Too many redirects'));
        } else {
          url = res.headers.location;
          stream.emit('redirect', url);
          doDownload();
        }
        return;
      } else if (res.statusCode < 200 || 400 <= res.statusCode) {
        let err = new Error('Status code: ' + res.statusCode);
        if (res.statusCode >= 500) {
          onRequestError(err, res.statusCode);
        } else {
          onError(err);
        }
        return;
      }
      if (callback) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          callback(null, res, body);
        });
      } else {
        res.pipe(stream);
        myres = res;
        stream.emit('response', res);
        res.on('error', onError);
      }
    });
    myreq.on('error', onRequestError);
    stream.emit('request', myreq);
  }

  stream.abort = () => {
    aborted = true;
    stream.emit('abort');
    if (myreq) { myreq.abort(); }
    if (myres) { myres.unpipe(stream); }
  };

  process.nextTick(doDownload);
  return callback ? null : stream;
};
