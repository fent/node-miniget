const fs          = require('fs');
const path        = require('path');
const zlib        = require('zlib');
const assert      = require('assert');
const nock        = require('nock');
const lolex       = require('lolex');
const streamEqual = require('stream-equal');
const miniget     = require('../lib/index');
require('longjohn');

nock.disableNetConnect();

describe('Make a request', () => {
  afterEach(() => { nock.cleanAll(); });
  let clock;
  beforeEach(() => clock = lolex.install());
  afterEach(() => clock.uninstall());

  describe('with callback', () => {
    it('Gives contents of page', (done) => {
      const scope = nock('http://website.com')
        .get('/path')
        .replyWithFile(200, __filename);
      miniget('http://website.com/path', (err, res, body) => {
        assert.ifError(err);
        scope.done();
        assert.equal(res.statusCode, 200);
        assert.ok(body.length > 100);
        done();
      });
    });

    describe('with options', () => {
      it('Makes request with options', (done) => {
        const scope = nock('http://website.com', {
          reqheaders: { 'User-Agent': 'miniget' },
        })
          .get('/path')
          .replyWithFile(200, __filename);
        miniget('http://website.com/path', {
          headers: { 'User-Agent': 'miniget' },
        }, (err, res, body) => {
          assert.ifError(err);
          scope.done();
          assert.equal(res.statusCode, 200);
          assert.ok(body.length > 100);
          done();
        });
      });
    });

    describe('that errors', () => {
      it('Calls callback with error', (done) => {
        const scope = nock('https://mysite.com')
          .get('/path')
          .replyWithError('ENOTFOUND');
        miniget('https://mysite.com/path', { maxRetries: 0 }, (err) => {
          assert.ok(err);
          assert.equal(err.message, 'ENOTFOUND');
          scope.done();
          done();
        });
      });
    });

    describe('with bad path', () => {
      it('Calls callback with error', (done) => {
        const scope = nock('https://mysite.com')
          .get('/badpath')
          .reply(404, 'not exists');
        miniget('https://mysite.com/badpath', (err) => {
          assert.ok(err);
          scope.done();
          done();
        });
      });
    });
  });

  describe('that errors', () => {
    it('Emits error event', (done) => {
      const scope = nock('https://mysite.com')
        .get('/path')
        .replyWithError('ENOTFOUND')
        .get('/path')
        .replyWithError('ENOTFOUND')
        .get('/path')
        .reply(500, 'oh no 3');
      const stream = miniget('https://mysite.com/path');
      stream.on('request', () => { clock.tick(1); });
      stream.on('retry', (retryCount) => {
        clock.tick(retryCount * 100);
      });
      stream.on('error', (err) => {
        assert.equal(err.message, 'Status code: 500');
        scope.done();
        done();
      });
    });

    describe('without retries', () => {
      it('Emits error event', (done) => {
        const scope = nock('https://mysite.com')
          .get('/path')
          .replyWithError('oh no 1');
        const stream = miniget('https://mysite.com/path', { maxRetries: 0 });
        stream.on('error', (err) => {
          assert.equal(err.message, 'oh no 1');
          scope.done();
          done();
        });
      });
    });
  });

  describe('using https protocol', () => {
    it('Uses the https module', (done) => {
      const scope = nock('https://secureplace.net')
        .get('/')
        .reply(200);
      const stream = miniget('https://secureplace.net');
      stream.on('error', done);
      stream.on('end', () => {
        scope.done();
        done();
      });
      stream.resume();
    });
  });

  describe('without callback', () => {
    it('Returns a stream', (done) => {
      const scope = nock('http://website.com')
        .get('/path')
        .replyWithFile(200, __filename);
      const stream = miniget('http://website.com/path');
      stream.on('error', done);
      stream.on('response', (res) => {
        res.on('error', done);
        res.on('end', () => {
          scope.done();
          done();
        });
        res.resume();
      });
    });
  });

  describe('with an incorrect URL', () => {
    describe('with callback', () => {
      it('Called with error', (done) => {
        miniget('file:///Users/roly/', (err) => {
          assert.ok(err);
          done();
        });
      });
    });

    describe('without callback', () => {
      it('Throws error', (done) => {
        miniget('file:///Users/roly/').on('error', (err) => {
          assert.ok(err);
          done();
        });
      });
    });
  });

  describe('that redirects', () => {
    it('Should download file after redirect', (done) => {
      const scope = nock('http://mysite.com')
        .get('/pathy')
        .reply(302, '', { Location: 'http://mysite.com/redirected!' })
        .get('/redirected!')
        .reply(200, 'Helloo!');
      const stream = miniget('http://mysite.com/pathy');
      stream.on('error', done);
      stream.on('data', (body) => {
        scope.done();
        assert.equal(body, 'Helloo!');
        done();
      });
      stream.on('redirect', () => {
        clock.tick(1);
      });
    });

    describe('too many times', () => {
      it('Emits error after 3 retries', (done) => {
        const scope = nock('http://yoursite.com')
          .get('/first-request')
          .reply(302, '', { Location: 'http://yoursite.com/redirect-1' })
          .get('/redirect-1')
          .reply(302, '', { Location: 'http://yoursite.com/redirect-2' })
          .get('/redirect-2')
          .reply(302, '', { Location: 'http://yoursite.com/redirect-3' });
        const stream = miniget('http://yoursite.com/first-request');
        stream.on('error', (err) => {
          assert.ok(err);
          scope.done();
          assert.equal(err.message, 'Too many redirects');
          done();
        });
        stream.on('redirect', () => {
          clock.tick(1);
        });
      });
    });

    describe('with `retry-after` header', () => {
      it('Redirects after given time', (done) => {
        const scope = nock('http://mysite2.com')
          .get('/pathos/to/resource')
          .reply(301, '', {
            Location: 'http://mysite2.com/newpath/to/source',
            'Retry-After': '300',
          })
          .get('/newpath/to/source')
          .reply(200, 'hi world!!');
        const stream = miniget('http://mysite2.com/pathos/to/resource');
        stream.on('error', done);
        stream.on('data', (body) => {
          scope.done();
          assert.equal(body, 'hi world!!');
          done();
        });
        stream.on('redirect', () => {
          clock.tick(300 * 1000);
        });
      });
    });
  });

  describe('that gets api limited', () => {
    it('Retries the request after some time', (done) => {
      const scope = nock('https://mysite.io')
        .get('/api/v1/data')
        .reply(429, 'slow down')
        .get('/api/v1/data')
        .reply(200, 'where are u');
      const stream = miniget('https://mysite.io/api/v1/data');
      stream.on('error', done);
      stream.on('data', (data) => {
        scope.done();
        assert.equal(data, 'where are u');
        done();
      });
      stream.on('retry', () => {
        clock.tick(1000);
      });
    });
    describe('with `retry-after` header', () => {
      it('Retries after given time', (done) => {
        const scope = nock('https://mysite.io')
          .get('/api/v1/dota')
          .reply(429, 'slow down', { 'Retry-After': '3600' })
          .get('/api/v1/dota')
          .reply(200, 'where are u');
        const stream = miniget('https://mysite.io/api/v1/dota');
        stream.on('error', done);
        stream.on('data', (data) => {
          scope.done();
          assert.equal(data, 'where are u');
          done();
        });
        stream.on('retry', () => {
          // Test that ticking by a bit does not retry the request.
          clock.tick(1000);
          assert.ok(!scope.isDone());
          clock.tick(3600 * 1000);
        });
      });
    });
  });

  describe('using the `transform` option', () => {
    it('Calls `transform` function and customizes request', (done) => {
      const scope = nock('http://other.com')
        .get('/http://supplies.com/boxes')
        .reply(200, '[  ]');
      miniget('http://supplies.com/boxes', {
        transform: (parsed) => {
          return {
            host: 'other.com',
            path: '/' + parsed.href,
          };
        },
      }, (err, res, body) => {
        scope.done();
        assert.ifError(err);
        assert.equal(res.statusCode, 200);
        assert.equal(body, '[  ]');
        done();
      });
    });
    it('Calls `transform` function and customizes request with protocol changing', (done) => {
      const scope = nock('http://that.com')
        .get('/')
        .reply(200, '[  ]');
      miniget('https://that.com', {
        transform: (parsed) => {
          parsed.protocol = 'http:';
          return parsed;
        },
      }, (err, res, body) => {
        scope.done();
        assert.ifError(err);
        assert.equal(res.statusCode, 200);
        assert.equal(body, '[  ]');
        done();
      });
    });
  });

  describe('that disconnects before end', () => {
    const file = path.resolve(__dirname, 'video.flv');
    let filesize;
    before((done) => {
      fs.stat(file, (err, stat) => {
        assert.ifError(err);
        filesize = stat.size;
        done();
      });
    });

    const destroy = (req, res) => {
      req.abort();
      res.unpipe();
    };

    it('Still downloads entire file', (done) => {
      const scope = nock('http://mysite.com')
        .get('/myfile')
        .replyWithFile(200, file, {
          'content-length': filesize,
          'accept-ranges': 'bytes',
        });
      const stream = miniget('http://mysite.com/myfile', { maxReconnects: 1 });
      let req, res;
      stream.on('request', (a) => { req = a; });
      stream.on('response', (a) => { res = a; });
      let reconnects = 0;
      stream.on('reconnect', () => {
        reconnects++;
        clock.tick(100);
      });
      let downloaded = 0, destroyed = false;
      stream.on('data', (chunk) => {
        downloaded += chunk.length;
        if (!destroyed && downloaded / filesize >= 0.3) {
          destroyed = true;
          scope.get('/myfile')
            .reply(206, () => fs.createReadStream(file, { start: downloaded }), {
              'content-range': `bytes ${downloaded}-${filesize}/${filesize}`,
              'content-length': filesize - downloaded,
              'accept-ranges': 'bytes',
            });
          destroy(req, res);
        }
      });
      stream.on('error', done);
      stream.on('end', () => {
        scope.done();
        assert.ok(destroyed);
        assert.equal(reconnects, 1);
        assert.equal(downloaded, filesize);
        done();
      });
    });

    describe('without an error', () => {
      it('Still downloads entire file', (done) => {
        const scope = nock('http://mysite.com')
          .get('/myfile')
          .replyWithFile(200, file, {
            'content-length': filesize,
            'accept-ranges': 'bytes',
          });
        const stream = miniget('http://mysite.com/myfile', { maxReconnects: 1 });
        let res;
        stream.on('response', (a) => { res = a; });
        let reconnects = 0;
        stream.on('reconnect', () => {
          reconnects++;
          clock.tick(100);
        });
        let downloaded = 0, destroyed = false;
        stream.on('data', (chunk) => {
          downloaded += chunk.length;
          if (!destroyed && downloaded / filesize >= 0.3) {
            destroyed = true;
            scope.get('/myfile')
              .reply(206, () => fs.createReadStream(file, { start: downloaded }), {
                'content-range': `bytes ${downloaded}-${filesize}/${filesize}`,
                'content-length': filesize - downloaded,
                'accept-ranges': 'bytes',
              });
            res.emit('end');
          }
        });
        stream.on('error', done);
        stream.on('end', () => {
          scope.done();
          assert.ok(destroyed);
          assert.equal(reconnects, 1);
          assert.equal(downloaded, filesize);
          done();
        });
      });

      describe('without enough reconnects', () => {
        it('Downloads partial file', (done) => {
          const scope = nock('http://mysite.com')
            .get('/yourfile')
            .replyWithFile(200, file, {
              'content-length': filesize,
              'accept-ranges': 'bytes',
            });
          const stream = miniget('http://mysite.com/yourfile', {
            maxReconnects: 1,
            maxRetries: 0,
          });
          let res;
          stream.on('response', (a) => {
            res = a; });
          let reconnects = 0;
          stream.on('reconnect', () => {
            reconnects++;
            scope.get('/yourfile')
              .reply(206, fs.createReadStream(file, { start: downloaded }), {
                'content-range': `bytes ${downloaded}-${filesize}/${filesize}`,
                'content-length': filesize - downloaded,
                'accept-ranges': 'bytes',
              });
            clock.tick(100);
          });
          let downloaded = 0, destroyed = false;
          stream.on('data', (chunk) => {
            downloaded += chunk.length;
            if (downloaded / filesize >= 0.3) {
              destroyed = true;
              res.emit('end');
            }
          });
          stream.on('error', done);
          stream.on('end', () => {
            scope.done();
            assert.ok(destroyed);
            assert.equal(reconnects, 1);
            assert.notEqual(downloaded, filesize);
            done();
          });
        });
      });
    });

    describe('too many times', () => {
      it('Emits error', (done) => {
        const scope = nock('http://mysite.com')
          .get('/myfile')
          .replyWithFile(200, file, {
            'content-length': filesize,
            'accept-ranges': 'bytes',
          });
        const stream = miniget('http://mysite.com/myfile', {
          maxReconnects: 2,
          headers: { Range: 'bad' },
        });
        let req, res;
        stream.on('request', (a) => { req = a; });
        stream.on('response', (a) => { res = a; });
        let reconnects = 0;
        stream.on('reconnect', () => {
          reconnects++;
          clock.tick(100);
        });
        let downloaded = 0, destroyed = false;
        stream.on('data', (chunk) => {
          downloaded += chunk.length;
          if (downloaded / filesize >= 0.3) {
            destroyed = true;
            if (reconnects < 2) {
              scope.get('/myfile')
                .reply(206, () => fs.createReadStream(file, { start: downloaded }), {
                  'content-range': `bytes ${downloaded}-${filesize}/${filesize}`,
                  'content-length': filesize - downloaded,
                  'accept-ranges': 'bytes',
                });
            }
            destroy(req, res);
          }
        });
        stream.on('error', (err) => {
          assert.equal(err.message, 'socket hang up');
          scope.done();
          assert.equal(reconnects, 2);
          assert.ok(destroyed);
          assert.notEqual(downloaded, filesize);
          done();
        });
        stream.on('end', () => {
          // Does fire in node v12
          // throw Error('should not end');
        });
      });
    });

    describe('with ranged request headers', () => {
      it('Downloads correct portion of file', (done) => {
        const start = Math.round(filesize / 3);
        const scope = nock('http://mysite.com', { reqheaders: { Range: /bytes=/ } })
          .get('/myfile')
          .reply(206, () => fs.createReadStream(file, { start }), {
            'content-length': filesize - start,
            'content-range': `bytes ${start}-${filesize}/${filesize}`,
            'accept-ranges': 'bytes',
          });
        const stream = miniget('http://mysite.com/myfile', {
          maxReconnects: 1,
          headers: { Range: `bytes=${start}-` },
        });
        let req, res;
        stream.on('request', (a) => { req = a; });
        stream.on('response', (a) => { res = a; });
        let reconnects = 0;
        stream.on('reconnect', () => {
          reconnects++;
          clock.tick(100);
        });
        let downloaded = start, destroyed = false;
        stream.on('data', (chunk) => {
          downloaded += chunk.length;
          if (!destroyed && downloaded / filesize >= 0.5) {
            destroyed = true;
            scope.get('/myfile')
              .reply(206, () => fs.createReadStream(file, { start: downloaded }), {
                'content-range': `bytes ${downloaded}-${filesize}/${filesize}`,
                'content-length': filesize - downloaded,
                'accept-ranges': 'bytes',
              });
            destroy(req, res);
          }
        });
        stream.on('error', done);
        stream.on('end', () => {
          scope.done();
          assert.ok(destroyed);
          assert.equal(reconnects, 1);
          assert.equal(downloaded, filesize);
          done();
        });
      });
    });
  });

  describe('that gets aborted', () => {
    describe('immediately', () => {
      it('Does not call callback or end stream', (done) => {
        nock('http://anime.me')
          .get('/')
          .reply(200, 'ooooaaaaaaaeeeee');
        const stream = miniget('http://anime.me');
        stream.on('end', () => {
          throw Error('`end` event should not be called');
        });
        stream.on('abort', done);
        stream.on('error', done);
        stream.abort();
      });
    });

    describe('after getting response but before end', () => {
      it('Response does not give any more data', (done) => {
        const scope = nock('http://www.google1.com')
          .get('/one')
          .delayBody(100)
          .reply(200, '<html></html>');
        const stream = miniget('http://www.google1.com/one');
        stream.on('end', () => {
          throw Error('`end` event should not be called');
        });
        let abortCalled = false;
        stream.on('abort', () => { abortCalled = true; });
        stream.on('data', () => {
          throw Error('Should not read any data');
        });
        stream.on('error', (err) => {
          scope.done();
          assert.ok(abortCalled);
          assert.equal(err.message, 'socket hang up');
          done();
        });
        stream.on('response', () => {
          stream.abort();
        });
      });
    });
  });

  describe('with `acceptEncoding` option', () => {
    const file = path.resolve(__dirname, 'video.flv');
    let filesize;
    before((done) => {
      fs.stat(file, (err, stat) => {
        assert.ifError(err);
        filesize = stat.size;
        done();
      });
    });

    it('Decompresses stream', (done) => {
      const res = fs.createReadStream(file).pipe(new zlib.createGzip());
      const scope = nock('http://yoursite.com', {
        reqheaders: { 'Accept-Encoding': 'gzip' }
      })
        .get('/compressedfile')
        .reply(200, res, {
          'content-length': filesize,
          'content-encoding': 'gzip',
        });
      const stream = miniget('http://yoursite.com/compressedfile', {
        acceptEncoding: { gzip: () => new zlib.createGunzip() },
        maxRetries: 0,
      });
      streamEqual(fs.createReadStream(file), stream, (err, equal) => {
        assert.ifError(err);
        assert.ok(equal);
        scope.done();
        done();
      });
    });

    describe('compressed twice', () => {
      it('Decompresses stream', (done) => {
        const res = fs.createReadStream(file)
          .pipe(zlib.createGzip())
          .pipe(zlib.createDeflate());
        const scope = nock('http://yoursite.com', {
          reqheaders: { 'Accept-Encoding': 'gzip, deflate' }
        })
          .get('/compressedfile')
          .reply(200, res, {
            'content-length': filesize,
            'content-encoding': 'gzip, deflate',
          });
        const stream = miniget('http://yoursite.com/compressedfile', {
          acceptEncoding: {
            gzip: () => zlib.createGunzip(),
            deflate: () => zlib.createInflate(),
          },
          maxRetries: 0,
        });
        streamEqual(fs.createReadStream(file), stream, (err, equal) => {
          assert.ifError(err);
          assert.ok(equal);
          scope.done();
          done();
        });
      });
    });

    describe('compressed incorrectly', () => {
      it('Emits compression error', (done) => {
        const res = fs.createReadStream(file)
          .pipe(zlib.createGzip())
          .pipe(zlib.createDeflate());
        const scope = nock('http://yoursite.com', {
          reqheaders: { 'Accept-Encoding': 'gzip, deflate' }
        })
          .get('/compressedfile')
          .reply(200, res, {
            'content-length': filesize,
            'content-encoding': 'deflate, gzip',
          });
        const stream = miniget('http://yoursite.com/compressedfile', {
          maxRetries: 0,
          acceptEncoding: {
            gzip: () => zlib.createGunzip(),
            deflate: () => zlib.createInflate(),
          }
        });
        streamEqual(fs.createReadStream(file), stream, (err) => {
          assert.ok(err);
          assert.equal(err.message, 'incorrect header check');
          scope.done();
          done();
        });
      });
    });

    describe('without matching decompressing stream', () => {
      it('Gets original compressed stream', (done) => {
        const res = fs.createReadStream(file).pipe(zlib.createGzip());
        const scope = nock('http://yoursite.com', {
          reqheaders: { 'Accept-Encoding': 'deflate' }
        })
          .get('/compressedfile')
          .reply(200, res, {
            'content-length': filesize,
            'content-encoding': 'gzip',
          });
        const stream = miniget('http://yoursite.com/compressedfile', {
          acceptEncoding: {
            deflate: () => zlib.createInflate(),
          },
          maxRetries: 0,
        });
        const expected = fs.createReadStream(file).pipe(zlib.createGzip());
        streamEqual(expected, stream, (err, equal) => {
          assert.ifError(err);
          assert.ok(equal);
          scope.done();
          done();
        });
      });
    });
  });
});
