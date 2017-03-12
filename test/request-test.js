const assert  = require('assert');
const nock    = require('nock');
const miniget = require('../lib/index');


describe('Make a request', function() {
  before(function() { nock.disableNetConnect(); });
  after(function() { nock.enableNetConnect(); });

  describe('with callback', function() {
    it('Gives contents of page', function(done) {
      var scope = nock('http://website.com')
        .get('/path')
        .replyWithFile(200, __filename);
      miniget('http://website.com/path', function(err, res, body) {
        assert.ifError(err);
        scope.done();
        assert.equal(res.statusCode, 200);
        assert.ok(body.length > 100);
        done();
      });
    });

    describe('with options', function() {
      it('Makes request with options', function(done) {
        var scope = nock('http://website.com', {
          reqheaders: { 'User-Agent': 'miniget' },
        })
          .get('/path')
          .replyWithFile(200, __filename);
        miniget('http://website.com/path', {
          headers: { 'User-Agent': 'miniget' },
        }, function(err, res, body) {
          assert.ifError(err);
          scope.done();
          assert.equal(res.statusCode, 200);
          assert.ok(body.length > 100);
          done();
        });
      });
    });

    describe('that errors', function() {
      it('Calls callback with error', function(done) {
        var scope = nock('https://mysite.com')
          .get('/path')
          .replyWithError('oh no');
        miniget('https://mysite.com/path', function(err) {
          assert.ok(err);
          scope.done();
          done();
        });
      });
    });

    describe('with bad path', function() {
      it('Calls callback with error', function(done) {
        var scope = nock('https://mysite.com')
          .get('/badpath')
          .reply(404, 'not exists');
        miniget('https://mysite.com/badpath', function(err) {
          assert.ok(err);
          scope.done();
          done();
        });
      });
    });
  });

  describe('using https protocol', function() {
    it('Uses the https module', function(done) {
      var scope = nock('https://secureplace.net')
        .get('/')
        .reply(200);
      var stream = miniget('https://secureplace.net');
      stream.on('error', done);
      stream.on('end', function() {
        scope.done();
        done();
      });
      stream.resume();
    });
  });

  describe('without callback', function() {
    it('Returns a stream', function(done) {
      var scope = nock('http://website.com')
        .get('/path')
        .replyWithFile(200, __filename);
      var stream = miniget('http://website.com/path');
      stream.on('error', done);
      stream.on('response', function(res) {
        res.on('error', done);
        res.on('end', function() {
          scope.done();
          done();
        });
        res.resume();
      });
    });
  });

  describe('with an incorrect URL', function() {
    describe('with callback', function() {
      it('Called with error', function(done) {
        miniget('file:///Users/roly/', function(err) {
          assert.ok(err);
          done();
        });
      });
    });

    describe('without callback', function() {
      it('Throws error', function(done) {
        miniget('file:///Users/roly/').on('error', function(err) {
          assert.ok(err);
          done();
        });
      });
    });
  });

  describe('that redirects', function() {
    it('Should download file after redirect', function(done) {
      var scope = nock('http://mysite.com');
      scope
        .get('/pathy')
        .reply(302, '', { Location: 'http://mysite.com/redirected!' });
      scope
        .get('/redirected!')
        .reply(200, 'Helloo!');
      miniget('http://mysite.com/pathy', function(err, res, body) {
        assert.ifError(err);
        scope.done();
        assert.equal(res.statusCode, 200);
        assert.equal(body, 'Helloo!');
        done();
      });
    });

    describe('too many times', function() {
      it('Emits error after 3 retries', function(done) {
        var scope = nock('http://yoursite.com');
        scope
          .get('/one')
          .reply(302, '', { Location: 'http://yoursite.com/two' });
        scope
          .get('/two')
          .reply(302, '', { Location: 'http://yoursite.com/three' });
        scope
          .get('/three')
          .reply(302, '', { Location: 'http://yoursite.com/four' });
        miniget('http://yoursite.com/one', function(err) {
          assert.ok(err);
          scope.done();
          assert.equal(err.message, 'Too many redirects');
          done();
        });
      });
    });
  });

  describe('using the `transform` option', function() {
    it('Calls `transform` function and customizes request', function(done) {
      var scope = nock('http://other.com')
        .get('/http://supplies.com/boxes')
        .reply(200, '[  ]');
      miniget('http://supplies.com/boxes', {
        transform: function(parsed) {
          return {
            host: 'other.com',
            path: '/' + parsed.href,
          };
        },
      }, function(err, res, body) {
        scope.done();
        assert.ifError(err);
        assert.equal(res.statusCode, 200);
        assert.equal(body, '[  ]');
        done();
      });
    });
  });

  describe('that gets aborted', function() {
    describe('immediately', function() {
      it('Does not call callback or end stream', function(done) {
        var scope = nock('http://anime.me')
          .get('/')
          .reply(200, 'ooooaaaaaaaeeeee');
        var stream = miniget('http://anime.me');
        stream.on('end', function() {
          throw Error('`end` event should not be called');
        });
        var abortCalled = false;
        stream.on('abort', function() { abortCalled = true; });
        stream.on('error', function(err) {
          scope.done();
          assert.ok(abortCalled);
          assert.ok(err);
          assert.equal(err.message, 'socket hang up');
          done();
        });
        stream.abort();
      });
    });

    describe('after getting response but before end', function() {
      it('Response does not give any more data', function(done) {
        var scope = nock('http://www.google1.com')
          .get('/one')
          .delayBody(500)
          .reply(200, '<html></html>');
        var stream = miniget('http://www.google1.com/one');
        stream.on('end', function() {
          throw Error('`end` event should not be called');
        });
        var abortCalled = false;
        stream.on('abort', function() { abortCalled = true; });
        stream.on('data', function() {
          throw Error('Should not read any data');
        });
        stream.on('error', function(err) {
          scope.done();
          assert.ok(abortCalled);
          assert.equal(err.message, 'socket hang up');
          done();
        });
        stream.on('response', function() {
          stream.abort();
        });
      });
    });
  });
});
