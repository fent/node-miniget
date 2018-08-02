const assert  = require('assert');
const nock    = require('nock');
const miniget = require('../lib/index');


describe('Make a request', () => {
  before(() => { nock.disableNetConnect(); });
  after(() => { nock.enableNetConnect(); });
  afterEach(() => { nock.cleanAll(); });

  describe('with callback', () => {
    it('Gives contents of page', (done) => {
      let scope = nock('http://website.com')
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
        let scope = nock('http://website.com', {
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
        let scope = nock('https://mysite.com')
          .get('/path')
          .replyWithError('oh no');
        miniget('https://mysite.com/path', (err) => {
          assert.ok(err);
          scope.done();
          done();
        });
      });
    });

    describe('with bad path', () => {
      it('Calls callback with error', (done) => {
        let scope = nock('https://mysite.com')
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

  describe('using https protocol', () => {
    it('Uses the https module', (done) => {
      let scope = nock('https://secureplace.net')
        .get('/')
        .reply(200);
      let stream = miniget('https://secureplace.net');
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
      let scope = nock('http://website.com')
        .get('/path')
        .replyWithFile(200, __filename);
      let stream = miniget('http://website.com/path');
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
      let scope = nock('http://mysite.com');
      scope
        .get('/pathy')
        .reply(302, '', { Location: 'http://mysite.com/redirected!' });
      scope
        .get('/redirected!')
        .reply(200, 'Helloo!');
      miniget('http://mysite.com/pathy', (err, res, body) => {
        assert.ifError(err);
        scope.done();
        assert.equal(res.statusCode, 200);
        assert.equal(body, 'Helloo!');
        done();
      });
    });

    describe('too many times', () => {
      it('Emits error after 3 retries', (done) => {
        let scope = nock('http://yoursite.com');
        scope
          .get('/one')
          .reply(302, '', { Location: 'http://yoursite.com/two' });
        scope
          .get('/two')
          .reply(302, '', { Location: 'http://yoursite.com/three' });
        scope
          .get('/three')
          .reply(302, '', { Location: 'http://yoursite.com/four' });
        miniget('http://yoursite.com/one', (err) => {
          assert.ok(err);
          scope.done();
          assert.equal(err.message, 'Too many redirects');
          done();
        });
      });
    });
  });

  describe('using the `transform` option', () => {
    it('Calls `transform` function and customizes request', (done) => {
      let scope = nock('http://other.com')
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
  });

  describe('that gets aborted', () => {
    describe('immediately', () => {
      it('Does not call callback or end stream', (done) => {
        nock('http://anime.me')
          .get('/')
          .reply(200, 'ooooaaaaaaaeeeee');
        let stream = miniget('http://anime.me');
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
        let scope = nock('http://www.google1.com')
          .get('/one')
          .delayBody(500)
          .reply(200, '<html></html>');
        let stream = miniget('http://www.google1.com/one');
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
});
