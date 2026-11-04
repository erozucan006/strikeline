// Test stand-in for the supabase-js browser bundle (used by test/serve.js --db).
// Same surface the page uses: auth.getSession/onAuthStateChange/signInWithOtp/signOut and rpc().
// rpc() is forwarded to the local server, which runs the real SQL functions in PGlite.
// "Clicking the emailed link" is simulated with window.__fakeLogin().
(function () {
  var KEY = "fake-sb-session";
  function createClient(url) {
    var listeners = [];
    var get = function () { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } };
    var emit = function (ev, s) { listeners.forEach(function (f) { f(ev, s); }); };
    var post = function (path, body) {
      return fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        .then(function (r) { return r.json(); });
    };
    window.__fakeLogin = function () {
      var r = window.__lastOtp; if (!r) throw new Error("no link sent");
      var s = { user: { id: r.id, email: r.email } };
      localStorage.setItem(KEY, JSON.stringify(s)); emit("SIGNED_IN", s);
    };
    return {
      auth: {
        getSession: function () { return Promise.resolve({ data: { session: get() }, error: null }); },
        onAuthStateChange: function (cb) { listeners.push(cb); return { data: { subscription: { unsubscribe: function () {} } } }; },
        signInWithOtp: function (o) {
          return post("/otp", { email: o.email, redirect: o.options && o.options.emailRedirectTo })
            .then(function (r) { window.__lastOtp = r; return { data: {}, error: r.error || null }; });
        },
        signOut: function () { localStorage.removeItem(KEY); emit("SIGNED_OUT", null); return Promise.resolve({ error: null }); },
      },
      rpc: function (fn, args) {
        var s = get();
        return post("/rpc", { user: s && s.user.id, fn: fn, args: args || {} })
          .then(function (r) { return { data: r.data === undefined ? null : r.data, error: r.error || null }; });
      },
    };
  }
  window.supabase = { createClient: createClient };
})();
