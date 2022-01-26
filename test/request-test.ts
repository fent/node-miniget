import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import assert from 'assert';
import { Transform } from 'stream';
import { IncomingMessage, ClientRequest, RequestOptions } from 'http';

import miniget from '../dist';

import nock from 'nock';
import sinon from 'sinon';
import streamEqual from 'stream-equal';
import 'longjohn';

nock.disableNetConnect();

describe('Make a request', () => {
  afterEach(() => nock.cleanAll());
  let clock: sinon.SinonFakeTimers;
  beforeEach(() => clock = sinon.useFakeTimers());
  afterEach(() => clock.uninstall());

  const stub = sinon.stub(console, 'warn');
  after(() => stub.restore());

  describe('with `.text()`', () => {
    it('Gives entire contents of page', async() => {
      const scope = nock('http://webby.com')
        .get('/pathos')
        .replyWithFile(200, __filename);
      let body = await miniget('http://webby.com/pathos').text();
      scope.done();
      assert.ok(body.length > 100);
    });

    describe('that errors', () => {
      it('error is caught', async() => {
        const scope = nock('http://something.com')
          .get('/one/two/three')
          .replyWithError('NONONO');
        await assert.rejects(
          miniget('http://something.com/one/two/three', { maxRetries: 0 }).text(),
          { message: 'NONONO' },
        );
        scope.done();
      });
    });
  });

  describe('to a working site', () => {
    it('Returns a stream', done => {
      const scope = nock('http://website.com')
        .get('/path')
        .replyWithFile(200, __filename);
      const stream = miniget('http://website.com/path');
      stream.on('error', done);
      stream.on('end', () => {
        scope.done();
        done();
      });
      stream.resume();
    });
  });

  describe('with options', () => {
    it('Makes request with options', async() => {
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
    it('Emits error', done => {
      const scope = nock('https://mysite.com')
        .get('/badpath')
        .reply(404, 'not exists');
      let stream = miniget('https://mysite.com/badpath');
      stream.on('error', err => {
        scope.done();
        assert.ok(err);
        done();
      });
    });
  });

  describe('that errors', () => {
    it('Emits error event', done => {
      const scope = nock('https://mysite.com')
        .get('/path')
        .replyWithError('ENOTFOUND')
        .get('/path')
        .replyWithError('ENOTFOUND')
        .get('/path')
        .reply(500, 'oh no 3');
      const stream = miniget('https://mysite.com/path');
      stream.on('retry', retryCount => {
        process.nextTick(() => {
          clock.tick(retryCount * 100);
        });
      });
      stream.on('error', err => {
        scope.done();
        assert.equal(err.message, 'Status code: 500');
        assert.equal(err.statusCode, 500);
        done();
      });
    });

    describe('without retries', () => {
      it('Emits error event', done => {
        const scope = nock('https://mysite.com')
          .get('/path')
          .replyWithError('oh no 1');
        const stream = miniget('https://mysite.com/path', { maxRetries: 0 });
        stream.on('error', err => {
          assert.equal(err.message, 'oh no 1');
          scope.done();
          done();
        });
      });
    });
  });

  describe('using https protocol', () => {
    it('Uses the https module', done => {
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

  describe('with auth', () => {
    it('Passes auth to request', async() => {
      const scope = nock('https://lockbox.com')
        .get('/vault')
        .basicAuth({ user: 'john', pass: 'pass' })
        .reply(200);
      await miniget('https://john:pass@lockbox.com/vault');
      scope.done();
    });
  });

  describe('with URL object passed', () => {
    it('Creates request and gets correct response', async() => {
      const scope = nock('http://webby.com')
        .get('/pathos')
        .replyWithFile(200, __filename);
      let body = await miniget(new URL('http://webby.com/pathos')).text();
      scope.done();
      assert.ok(body.length > 100);
    });
  });

  describe('with an unknown URL protocol', () => {
    it('Emits error', done => {
      miniget('file:///path/to/file/').on('error', err => {
        assert.ok(err);
        assert.equal(err.message, 'Unsupported URL protocol');
        done();
      });
    });
  });

  describe('with an incorrect URL', () => {
    it('Emits error', done => {
      miniget('https://').on('error', err => {
        assert.ok(err);
        assert.equal(err.message, 'Invalid URL: https://');
        done();
      });
    });
  });

  describe('with an empty URL', () => {
    it('Emits error', done => {
      miniget('').on('error', err => {
        assert.ok(err);
        assert.equal(err.message, 'Invalid URL: ');
        done();
      });
    });
  });

  describe('with no URL', () => {
    it('Emits error', done => {
      miniget('undefined').on('error', err => {
        assert.ok(err);
        assert.equal(err.message, 'Invalid URL: undefined');
        done();
      });
    });
  });

  describe('with no https library defined', () => {
    let httpsLib: any;
    before(() => {
      // Runs once before the first test in this block
      httpsLib = miniget.httpLibs['https:'];
      miniget.httpLibs['https:'] = undefined as unknown as miniget.HTTPLib;
    });
    it('Catches error', done => {
      let stream = miniget('https://supplies.com/boxes');
      stream.on('error', err => {
        assert.equal(err.message, 'Unable to access http(s) library(s)');
        done();
      });
    });
    after(() => {
      // Runs once before the first test in this block
      miniget.httpLibs['https:'] = httpsLib;
    });
  });

  describe('that redirects', () => {
    it('Should download file after redirect', done => {
      const scope = nock('http://mysite.com')
        .get('/pathy')
        .reply(302, '', { Location: 'http://mysite.com/redirected!' })
        .get('/redirected!')
        .reply(200, 'Helloo!');
      const stream = miniget('http://mysite.com/pathy');
      stream.on('error', done);
      stream.on('data', body => {
        scope.done();
        assert.equal(body, 'Helloo!');
        done();
      });
      stream.on('redirect', () => {
        clock.tick(1);
      });
    });

    describe('too many times', () => {
      it('Emits error after 3 retries', done => {
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
        stream.on('error', err => {
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
      it('Redirects after given time', done => {
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
        stream.on('data', body => {
          scope.done();
          assert.equal(body, 'hi world!!');
          done();
        });
        stream.on('redirect', () => {
          clock.tick(300 * 1000);
        });
      });
    });

    describe('without `location` header', () => {
      it('Throws an error', done => {
        const scope = nock('http://mysite.com')
          .get('/pathy')
          .reply(302, '', {});
        const stream = miniget('http://mysite.com/pathy');
        stream.on('error', err => {
          scope.done();
          assert.equal(err.message, 'Redirect status code given with no location');
          done();
        });
      });
    });
  });

  describe('that gets rate limited', () => {
    it('Retries the request after some time', done => {
      const scope = nock('https://mysite.io')
        .get('/api/v1/data')
        .reply(429, 'slow down')
        .get('/api/v1/data')
        .reply(200, 'where are u');
      const stream = miniget('https://mysite.io/api/v1/data');
      stream.on('error', done);
      stream.on('data', data => {
        scope.done();
        assert.equal(data, 'where are u');
        done();
      });
      stream.on('retry', () => {
        clock.tick(1000);
      });
    });
    it('Emits error after multiple tries', done => {
      const scope = nock('https://mysite.io')
        .get('/api/v1/data')
        .reply(429, 'too many requests')
        .get('/api/v1/data')
        .reply(429, 'too many requests')
        .get('/api/v1/data')
        .reply(429, 'too many requests');

      const stream = miniget('https://mysite.io/api/v1/data');
      stream.on('error', err => {
        assert.ok(err);
        scope.done();
        assert.equal(err.message, 'Status code: 429');
        assert.equal(err.statusCode, 429);
        done();
      });
      stream.on('retry', () => {
        clock.tick(1000);
      });
    });
    describe('with `retry-after` header', () => {
      it('Retries after given time', done => {
        const scope = nock('https://mysite.io')
          .get('/api/v1/dota')
          .reply(429, 'slow down', { 'Retry-After': '3600' })
          .get('/api/v1/dota')
          .reply(200, 'where are u');
        const stream = miniget('https://mysite.io/api/v1/dota');
        stream.on('error', done);
        stream.on('data', data => {
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
    it('Calls `transform` function and customizes request', async() => {
      const scope = nock('http://other.com')
        .get('/http://supplies.com/boxes')
        .reply(200, '[  ]');
      let transformCalled = false;
      let body = await miniget('http://supplies.com/boxes', {
        transform: parsed => {
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
    it('Calls `transform` function and customizes request with protocol changing', async() => {
      const scope = nock('http://that.com')
        .get('/')
        .reply(200, '[  ]');
      let body = await miniget('https://that.com', {
        transform: parsed => {
          parsed.protocol = 'http:';
          return parsed;
        },
      }).text();
      scope.done();
      assert.equal(body, '[  ]');
    });
    describe('with bad URL', () => {
      it('Catches error', done => {
        let stream = miniget('http://supplies.com/boxes', {
          transform: parsed => {
            parsed.protocol = 'file';
            return parsed;
          },
        });
        stream.on('error', err => {
          assert.equal(err.message, 'Unsupported URL protocol from `transform` function');
          done();
        });
      });
    });
    describe('with no object returned', () => {
      it('Catches error', done => {
        let stream = miniget('http://supplies.com/boxes', {
          transform: (_: RequestOptions) => undefined as unknown as RequestOptions,
        });
        stream.on('error', err => {
          assert.equal(err.message, 'Unsupported URL protocol from `transform` function');
          done();
        });
      });
    });
    describe('with no http(s) library defined', () => {
      let httpsLib: any;
      before(() => {
        // Runs once before the first test in this block
        httpsLib = miniget.httpLibs['http:'];
        miniget.httpLibs['http:'] = undefined as unknown as miniget.HTTPLib;
      });
      it('Catches error', done => {
        let stream = miniget('https://supplies.com/boxes', {
          transform: parsed => {
            parsed.protocol = 'http:';
            return parsed;
          },
        });
        stream.on('error', err => {
          assert.equal(err.message, 'Unable to access http(s) library(s)');
          done();
        });
      });
      after(() => {
        // Runs once before the first test in this block
        miniget.httpLibs['http:'] = httpsLib;
      });
    });
    describe('that throws', () => {
      it('Catches error', done => {
        let stream = miniget('http://kanto.com', {
          transform: () => { throw Error('hello'); },
        });
        stream.on('error', err => {
          assert.equal(err.message, 'hello');
          done();
        });
      });
    });
  });

  describe('that disconnects before end', () => {
    const file = path.resolve(__dirname, 'video.flv');
    let filesize: number;
    before(done => {
      fs.stat(file, (err, stat) => {
        assert.ifError(err);
        filesize = stat.size;
        done();
      });
    });

    const destroy = (req: ClientRequest, res: IncomingMessage): void => {
      req.destroy();
      res.unpipe();
    };

    it('Still downloads entire file', done => {
      const scope = nock('http://mysite.com')
        .get('/myfile')
        .replyWithFile(200, file, {
          'content-length': `${filesize}`,
          'accept-ranges': 'bytes',
        });
      const stream = miniget('http://mysite.com/myfile', { maxReconnects: 1 });
      let req: ClientRequest, res: IncomingMessage;
      stream.on('request', a => { req = a; });
      stream.on('response', a => { res = a; });
      let reconnects = 0;
      stream.on('reconnect', () => {
        reconnects++;
        clock.tick(100);
      });
      let downloaded = 0, destroyed = false;
      stream.on('data', chunk => {
        downloaded += chunk.length;
        if (!destroyed && downloaded / filesize >= 0.3) {
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

    describe('without an error', () => {
      it('Still downloads entire file', done => {
        const scope = nock('http://mysite.com')
          .get('/myfile')
          .replyWithFile(200, file, {
            'content-length': `${filesize}`,
            'accept-ranges': 'bytes',
          });
        const stream = miniget('http://mysite.com/myfile', { maxReconnects: 1 });
        let res: IncomingMessage;
        stream.on('response', a => { res = a; });
        let reconnects = 0;
        stream.on('reconnect', () => {
          reconnects++;
          clock.tick(100);
        });
        let downloaded = 0, destroyed = false;
        stream.on('data', chunk => {
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
        it('Downloads partial file', done => {
          const scope = nock('http://mysite.com')
            .get('/yourfile')
            .replyWithFile(200, file, {
              'content-length': `${filesize}`,
              'accept-ranges': 'bytes',
            });
          const stream = miniget('http://mysite.com/yourfile', {
            maxReconnects: 1,
            maxRetries: 0,
          });
          let res: IncomingMessage;
          stream.on('response', a => {
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
          stream.on('data', chunk => {
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
      it('Emits error', done => {
        const scope = nock('http://mysite.com')
          .get('/myfile')
          .replyWithFile(200, file, {
            'content-length': `${filesize}`,
            'accept-ranges': 'bytes',
          });
        const stream = miniget('http://mysite.com/myfile', {
          maxReconnects: 2,
          headers: { Range: 'bad' },
        });
        let req: ClientRequest, res: IncomingMessage;
        stream.on('request', a => { req = a; });
        stream.on('response', a => { res = a; });
        let reconnects = 0;
        stream.on('reconnect', () => {
          reconnects++;
          clock.tick(100);
        });
        let downloaded = 0, destroyed = false;
        stream.on('data', chunk => {
          downloaded += chunk.length;
          if (downloaded / filesize >= 0.3) {
            destroyed = true;
            destroy(req, res);
            if (reconnects < 2) {
              scope.get('/myfile')
                .reply(206, () => fs.createReadStream(file, { start: downloaded }), {
                  'content-range': `bytes ${downloaded}-${filesize}/${filesize}`,
                  'content-length': `${filesize - downloaded}`,
                  'accept-ranges': 'bytes',
                });
            } else {
              scope.done();
              assert.equal(reconnects, 2);
              assert.ok(destroyed);
              assert.notEqual(downloaded, filesize);
              done();
            }
          }
        });
        stream.on('end', () => {
          // Does fire in node v12
          // done(Error('should not end'));
        });
      });
    });

    describe('with ranged request headers', () => {
      it('Downloads correct portion of file', done => {
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
        stream.on('request', a => { req = a; });
        stream.on('response', a => { res = a; });
        let reconnects = 0;
        stream.on('reconnect', () => {
          reconnects++;
          clock.tick(100);
        });
        let downloaded = start, destroyed = false;
        stream.on('data', chunk => {
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

  describe('that gets destroyed', () => {
    describe('immediately', () => {
      it('Does not end stream', done => {
        nock('http://anime.me')
          .get('/')
          .reply(200, 'ooooaaaaaaaeeeee');
        const stream = miniget('http://anime.me');
        stream.on('end', () => {
          done(Error('`end` event should not be called'));
        });
        stream.on('error', () => {
          // Ignore error on node v10, 12.
        });
        stream.destroy();
        done();
      });
    });
    describe('after getting `request`', () => {
      it('Does not start download, no `response` event', done => {
        nock('https://friend.com')
          .get('/yes')
          .reply(200, '<html>my reply :)</html>');
        const stream = miniget('https://friend.com/yes');
        stream.on('end', () => {
          done(Error('`end` event should not emit'));
        });
        stream.on('response', () => {
          done(Error('`response` event should not emit'));
        });
        stream.on('data', () => {
          done(Error('Should not read any data'));
        });
        stream.on('error', () => {
          // Ignore error on node v10, 12.
        });
        stream.on('request', () => {
          stream.destroy();
          done();
        });
      });
    });
    describe('after getting `response` but before end', () => {
      it('Response does not give any data', done => {
        const file = path.resolve(__dirname, 'video.flv');
        const scope = nock('http://www.google1.com')
          .get('/one')
          .delayBody(100)
          .replyWithFile(200, file);
        const stream = miniget('http://www.google1.com/one');
        stream.on('end', () => {
          done(Error('`end` event should not emit'));
        });

        stream.on('data', () => {
          done(Error('Should not read any data'));
        });
        const errorSpy = sinon.spy();
        stream.on('error', errorSpy);
        stream.on('response', () => {
          stream.destroy();
          scope.done();
          assert.ok(!errorSpy.called);
          done();
        });
      });
    });

    describe('using `abort()`', () => {
      it('Emits `abort` and does not end stream', done => {
        nock('http://anime.me')
          .get('/')
          .reply(200, 'ooooaaaaaaaeeeee');
        const stream = miniget('http://anime.me');
        stream.on('end', () => {
          done(Error('`end` event should not be called'));
        });
        stream.on('error', () => {
          // Ignore error on node v10, 12.
        });
        stream.on('abort', done);
        stream.abort();
      });
    });
  });

  describe('with `acceptEncoding` option', () => {
    const file = path.resolve(__dirname, 'video.flv');
    let filesize: number;
    before(done => {
      fs.stat(file, (err, stat) => {
        assert.ifError(err);
        filesize = stat.size;
        done();
      });
    });

    it('Decompresses stream', async() => {
      const res = fs.createReadStream(file).pipe(zlib.createGzip());
      const scope = nock('http://yoursite.com', {
        reqheaders: { 'Accept-Encoding': 'gzip' },
      })
        .get('/compressedfile')
        .reply(200, res, {
          'content-length': `${filesize}`,
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
      it('Decompresses stream', async() => {
        const res = fs.createReadStream(file)
          .pipe(zlib.createGzip())
          .pipe(zlib.createDeflate());
        const scope = nock('http://yoursite.com', {
          reqheaders: {},
        })
          .get('/compressedfile')
          .reply(200, res, {
            'content-length': `${filesize}`,
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
      it('Emits compression error', async() => {
        const res = fs.createReadStream(file)
          .pipe(zlib.createGzip())
          .pipe(zlib.createDeflate());
        const scope = nock('http://yoursite.com', {
          reqheaders: { 'Accept-Encoding': 'gzip, deflate' },
        })
          .get('/compressedfile')
          .reply(200, res, {
            'content-length': `${filesize}`,
            // Encoding is in reverse order.
            'content-encoding': 'deflate, gzip',
          });
        const stream = miniget('http://yoursite.com/compressedfile', {
          maxRetries: 0,
          acceptEncoding: {
            gzip: (): Transform => zlib.createGunzip(),
            deflate: (): Transform => zlib.createInflate(),
          },
        });
        await assert.rejects(
          streamEqual(fs.createReadStream(file), stream),
          { message: 'incorrect header check' },
        );
        scope.done();
      });
    });

    describe('without matching decompressing stream', () => {
      it('Gets original compressed stream', async() => {
        const res = fs.createReadStream(file).pipe(zlib.createGzip());
        const scope = nock('http://yoursite.com', {
          reqheaders: { 'Accept-Encoding': 'deflate' },
        })
          .get('/compressedfile')
          .reply(200, res, {
            'content-length': `${filesize}`,
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

    describe('destroy mid-stream', () => {
      it('Stops stream without error', done => {
        const res = fs.createReadStream(file)
          .pipe(zlib.createGzip())
          .pipe(zlib.createDeflate());
        const scope = nock('http://yoursite.com', {
          reqheaders: { 'Accept-Encoding': 'gzip, deflate' },
        })
          .get('/compressedfile')
          .reply(200, res, {
            'content-length': `${filesize}`,
            'content-encoding': 'gzip, deflate',
          });
        const stream = miniget('http://yoursite.com/compressedfile', {
          acceptEncoding: {
            gzip: (): Transform => zlib.createGunzip(),
            deflate: (): Transform => zlib.createInflate(),
          },
          maxRetries: 0,
        });
        stream.on('error', done);
        stream.resume();
        let downloaded = 0;
        stream.on('data', chunk => {
          downloaded += chunk.length;
          if (downloaded / filesize > 0.5) {
            stream.destroy();
            scope.done();
            done();
          }
        });
      });
    });
  });

  describe('`response` emits error after end', () => {
    it('Error does not get emitted to stream', done => {
      const scope = nock('https://hello.com')
        .get('/one/two')
        .reply(200, '<html></html>');
      const stream = miniget('https://hello.com/one/two');
      stream.resume();
      let res: IncomingMessage;
      stream.on('response', a => res = a);
      stream.on('error', done);
      stream.on('end', () => {
        process.nextTick(() => {
          res.emit('error', Error('random after end error'));
        });
        scope.done();
        done();
      });
    });
  });

  describe('with `method = "HEAD"`', () => {
    it('Emits `response`', done => {
      const scope = nock('http://hello.net')
        .head('/world')
        .reply(200, '', { 'content-length': '10' });
      const stream = miniget('http://hello.net/world', { method: 'HEAD' });
      stream.on('error', done);
      stream.on('response', res => {
        scope.done();
        assert.equal(res.headers['content-length'], '10');
        done();
      });
    });
  });

  it('Events from request and response are forwarded to miniget stream', done => {
    const scope = nock('https://randomhost.com')
      .get('/randompath')
      .reply(200, 'hi');
    const stream = miniget('https://randomhost.com/randompath');
    const socketSpy = sinon.spy();
    stream.on('socket', socketSpy);
    stream.on('end', () => {
      scope.done();
      assert.equal(socketSpy.callCount, 1);
      done();
    });
    stream.resume();
  });
});

describe('Import the module', () => {
  it('Exposes default options', () => {
    assert.ok(miniget.defaultOptions);
  });
  it('Exposes MinigetError', () => {
    assert.ok(miniget.MinigetError);
  });
});
