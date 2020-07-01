import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import assert from 'assert';
import nock from 'nock';
import lolex from 'lolex';
import streamEqual from 'stream-equal';
import miniget from '../dist';
import { Transform } from 'stream';
import { IncomingMessage, ClientRequest } from 'http';
import 'longjohn';

nock.disableNetConnect();

describe('Make a request', () => {
  afterEach(() => { nock.cleanAll(); });
  let clock: lolex.InstalledClock;
  beforeEach(() => clock = lolex.install());
  afterEach(() => clock.uninstall());

  describe('with `.text()`', () => {
    it('Gives entire contents of page', async () => {
      const scope = nock('http://webby.com')
        .get('/pathos')
        .replyWithFile(200, __filename);
      let body = await miniget('http://webby.com/pathos').text();
      scope.done();
      assert.ok(body.length > 100);
    });

    describe('that errors', () => {
      it('error is caught', async () => {
        const scope = nock('http://something.com')
          .get('/one/two/three')
          .replyWithError('NONONO');
        await assert.rejects(
          miniget('http://something.com/one/two/three', { maxRetries: 0 }).text(),
          null, 'NONONO'
        );
        scope.done();
      });
    });
  });

  describe('to a working site', () => {
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

  describe('with options', () => {
    it('Makes request with options', async () => {
      const scope = nock('http://website.com', {
        reqheaders: { 'User-Agent': 'miniget' },
      })
        .get('/path')
        .replyWithFile(200, __filename);
      let body = await miniget('http://website.com/path', {
        headers: { 'User-Agent': 'miniget' },
      }).text();
      scope.done();
      assert.ok(body.length > 100);
    });
  });

  describe('with bad path', () => {
    it('Emits error', (done) => {
      const scope = nock('https://mysite.com')
        .get('/badpath')
        .reply(404, 'not exists');
      let stream = miniget('https://mysite.com/badpath');
      stream.on('error', (err) => {
        scope.done();
        assert.ok(err);
        done();
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

  describe('with an incorrect URL', () => {
    it('Emits error', (done) => {
      miniget('file:///path/to/file/').on('error', (err) => {
        assert.ok(err);
        assert.equal(err.message, 'Invalid URL: file:///path/to/file/');
        done();
      });
    });
  });

  describe('with no URL', () => {
    it('Emits error', (done) => {
      miniget(undefined).on('error', (err) => {
        assert.ok(err);
        assert.equal(err.message, 'Invalid URL: undefined');
        done();
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
        const stream = miniget('http://yoursite.com/first-request', {
          maxRedirects: 2,
        });
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
    it('Emits error after multiple tries', (done) => {
      const scope = nock('https://mysite.io')
        .get('/api/v1/data')
        .reply(429, 'too many requests')
        .get('/api/v1/data')
        .reply(429, 'too many requests')
        .get('/api/v1/data')
        .reply(429, 'too many requests');

      const stream = miniget('https://mysite.io/api/v1/data');
      stream.on('error', (err) => {
        assert.ok(err);
        scope.done();
        assert.equal(err.message, 'Status code: 429');
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
    it('Calls `transform` function and customizes request', async () => {
      const scope = nock('http://other.com')
        .get('/http://supplies.com/boxes')
        .reply(200, '[  ]');
      let transformCalled = false;
      let body = await miniget('http://supplies.com/boxes', {
        transform: (parsed) => {
          transformCalled = true;
          return {
            host: 'other.com',
            path: `/${parsed.protocol}//${parsed.host}${parsed.path}`,
          };
        },
      }).text();
      assert.ok(transformCalled);
      scope.done();
      assert.equal(body, '[  ]');
    });
    it('Calls `transform` function and customizes request with protocol changing', async () => {
      const scope = nock('http://that.com')
        .get('/')
        .reply(200, '[  ]');
      let body = await miniget('https://that.com', {
        transform: (parsed) => {
          parsed.protocol = 'http:';
          return parsed;
        },
      }).text();
      scope.done();
      assert.equal(body, '[  ]');
    });
    describe('with bad URL', () => {
      it('Catches error', (done) => {
        let stream = miniget('http://supplies.com/boxes', {
          transform: (parsed) => {
            parsed.protocol = 'file';
            return parsed;
          },
        });
        stream.on('error', (err) => {
          assert.equal(err.message, 'Invalid URL object from `transform` function');
          done();
        });
      });
    });
    describe('with no object returned', () => {
      it('Catches error', (done) => {
        let stream = miniget('http://supplies.com/boxes', {
          transform: () => undefined,
        });
        stream.on('error', (err) => {
          assert.equal(err.message, 'Invalid URL object from `transform` function');
          done();
        });
      });
    });
    describe('that throws', () => {
      it('Catches error', (done) => {
        let stream = miniget('http://kanto.com', {
          transform: () => { throw Error('hello'); },
        });
        stream.on('error', (err) => {
          assert.equal(err.message, 'hello');
          done();
        });
      });
    });
  });

  describe('that disconnects before end', () => {
    const file = path.resolve(__dirname, 'video.flv');
    let filesize: number;
    before((done) => {
      fs.stat(file, (err, stat) => {
        assert.ifError(err);
        filesize = stat.size;
        done();
      });
    });

    const destroy = (req: ClientRequest, res: IncomingMessage): void => {
      req.abort();
      res.unpipe();
    };

    it('Still downloads entire file', (done) => {
      const scope = nock('http://mysite.com')
        .get('/myfile')
        .replyWithFile(200, file, {
          'content-length': filesize + '',
          'accept-ranges': 'bytes',
        });
      const stream = miniget('http://mysite.com/myfile', { maxReconnects: 1 });
      let req: ClientRequest, res: IncomingMessage;
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
              'content-length': `${(filesize - downloaded)}`,
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
            'content-length': filesize + '',
            'accept-ranges': 'bytes',
          });
        const stream = miniget('http://mysite.com/myfile', { maxReconnects: 1 });
        let res: IncomingMessage;
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
                'content-length': `${filesize - downloaded}`,
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
              'content-length': filesize + '',
              'accept-ranges': 'bytes',
            });
          const stream = miniget('http://mysite.com/yourfile', {
            maxReconnects: 1,
            maxRetries: 0,
          });
          let res: IncomingMessage;
          stream.on('response', (a) => {
            res = a;
          });
          let reconnects = 0;
          stream.on('reconnect', () => {
            reconnects++;
            scope.get('/yourfile')
              .reply(206, fs.createReadStream(file, { start: downloaded }), {
                'content-range': `bytes ${downloaded}-${filesize}/${filesize}`,
                'content-length': `${filesize - downloaded}`,
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
            'content-length': filesize + '',
            'accept-ranges': 'bytes',
          });
        const stream = miniget('http://mysite.com/myfile', {
          maxReconnects: 2,
          headers: { Range: 'bad' },
        });
        let req: ClientRequest, res: IncomingMessage;
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
                  'content-length': `${filesize - downloaded}`,
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
            'content-length': `${filesize - start}`,
            'content-range': `bytes ${start}-${filesize}/${filesize}`,
            'accept-ranges': 'bytes',
          });
        const stream = miniget('http://mysite.com/myfile', {
          maxReconnects: 1,
          headers: { Range: `bytes=${start}-` },
        });
        let req: ClientRequest, res: IncomingMessage;
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
                'content-length': `${filesize - downloaded}`,
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
      it('Does not end stream', (done) => {
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
    let filesize: number;
    before((done) => {
      fs.stat(file, (err, stat) => {
        assert.ifError(err);
        filesize = stat.size;
        done();
      });
    });

    it('Decompresses stream', async () => {
      const res = fs.createReadStream(file).pipe(zlib.createGzip());
      const scope = nock('http://yoursite.com', {
        reqheaders: { 'Accept-Encoding': 'gzip' }
      })
        .get('/compressedfile')
        .reply(200, res, {
          'content-length': filesize + '',
          'content-encoding': 'gzip',
        });
      const stream = miniget('http://yoursite.com/compressedfile', {
        acceptEncoding: { gzip: (): Transform => zlib.createGunzip() },
        maxRetries: 0,
      });
      let equal = await streamEqual(fs.createReadStream(file), stream);
      assert.ok(equal);
      scope.done();
    });

    describe('compressed twice', () => {
      it('Decompresses stream', async () => {
        const res = fs.createReadStream(file)
          .pipe(zlib.createGzip())
          .pipe(zlib.createDeflate());
        const scope = nock('http://yoursite.com', {
          reqheaders: {}
        })
          .get('/compressedfile')
          .reply(200, res, {
            'content-length': filesize + '',
            'content-encoding': 'gzip, deflate',
          });
        const stream = miniget('http://yoursite.com/compressedfile', {
          acceptEncoding: {
            gzip: (): Transform => zlib.createGunzip(),
            deflate: (): Transform => zlib.createInflate(),
          },
          maxRetries: 0,
        });
        let equal = await streamEqual(fs.createReadStream(file), stream);
        assert.ok(equal);
        scope.done();
      });
    });

    describe('compressed incorrectly', () => {
      it('Emits compression error', async () => {
        const res = fs.createReadStream(file)
          .pipe(zlib.createGzip())
          .pipe(zlib.createDeflate());
        const scope = nock('http://yoursite.com', {
          reqheaders: { 'Accept-Encoding': 'gzip, deflate' }
        })
          .get('/compressedfile')
          .reply(200, res, {
            'content-length': filesize + '',
            'content-encoding': 'deflate, gzip',
          });
        const stream = miniget('http://yoursite.com/compressedfile', {
          maxRetries: 0,
          acceptEncoding: {
            gzip: (): Transform => zlib.createGunzip(),
            deflate: (): Transform => zlib.createInflate(),
          }
        });
        await assert.rejects(
          streamEqual(fs.createReadStream(file), stream),
          null, 'incorrect header check'
        );
        scope.done();
      });
    });

    describe('without matching decompressing stream', () => {
      it('Gets original compressed stream', async () => {
        const res = fs.createReadStream(file).pipe(zlib.createGzip());
        const scope = nock('http://yoursite.com', {
          reqheaders: { 'Accept-Encoding': 'deflate' }
        })
          .get('/compressedfile')
          .reply(200, res, {
            'content-length': filesize + '',
            'content-encoding': 'gzip',
          });
        const stream = miniget('http://yoursite.com/compressedfile', {
          acceptEncoding: {
            deflate: (): Transform => zlib.createInflate(),
          },
          maxRetries: 0,
        });
        const expected = fs.createReadStream(file).pipe(zlib.createGzip());
        let equal = await streamEqual(expected, stream);
        assert.ok(equal);
        scope.done();
      });
    });
  });
});
