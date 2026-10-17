# -*- coding: utf-8 -*-
import io

APP = '/sdcard/Download/Operit/vapor-mad/js/app.js'
j = io.open(APP, encoding='utf-8').read()

# ============================================================
# 1) previewBuffer 支持音量曲线
# ============================================================
old = '''  function previewBuffer(buf, rate) {
    var ctx = ac();
    var src = ctx.createBufferSource();
    src.buffer = buf;
    if (rate && isFinite(rate) && rate > 0) src.playbackRate.value = rate;
    src.connect(S.master);
    src.start();
    S.nodes.add(src);
    src.onended = function () { S.nodes.delete(src); };
  }'''

new = '''  function previewBuffer(buf, rate, env) {
    var ctx = ac();
    var r = (rate && isFinite(rate) && rate > 0) ? rate : 1;
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = r;
    var t0 = ctx.currentTime + 0.02;

    if (env && env.length >= 2 && !envIsFlat(env)) {
      var gn = ctx.createGain();
      var N = 96;
      var curve = new Float32Array(N);
      for (var i = 0; i < N; i++) {
        var v = envAt(env, i / (N - 1));
        curve[i] = Math.max(0.0001, Math.min(1, v));
      }
      try {
        gn.gain.setValueCurveAtTime(curve, t0, Math.max(0.05, buf.duration / r));
      } catch (e) {
        gn.gain.value = 1;
      }
      src.connect(gn);
      gn.connect(S.master);
      src.start(t0);
      src.onended = function () {
        try { gn.disconnect(); } catch (e) { }
        S.nodes.delete(src);
      };
    } else {
      src.connect(S.master);
      src.start(t0);
      src.onended = function () { S.nodes.delete(src); };
    }

    S.nodes.add(src);
  }'''

if old in j:
    j = j.replace(old, new, 1)
    print('preview ok')
else:
    print('preview NOT FOUND')

# ============================================================
# 2) 试听调用处传入 env
# ============================================================
j = j.replace("    previewBuffer(out, WB.sample ? (WB.sample.rate || 1) : 1);",
              "    previewBuffer(out, WB.sample ? (WB.sample.rate || 1) : 1, WB.sample ? WB.sample.env : null);", 1)

# ============================================================
# 3) 其它调用 previewBuffer 的地方也带上 env（若有）
# ============================================================
j = j.replace("    previewBuffer(s.buffer);", "    previewBuffer(s.buffer, s.rate || 1, s.env);", 1)

# ============================================================
# 4) scheduleNote 的曲线分支加保护，避免 ramp 时间不单调时抛错
# ============================================================
old_env = '''      gn.gain.setValueAtTime(0, when);
      gn.gain.linearRampToValueAtTime(peak * envAt(env, t0b), when + atk);
      for (var ei = 0; ei < env.length; ei++) {
        var et = env[ei][0];
        if (et <= t0b || et >= t1b) continue;
        var f = (et - t0b) / dSpan;
        gn.gain.linearRampToValueAtTime(peak * env[ei][1], when + atk + f * body);
      }
      gn.gain.linearRampToValueAtTime(peak * envAt(env, t1b), when + dur);
      gn.gain.linearRampToValueAtTime(0, when + dur + 0.015);'''

new_env = '''      try {
        gn.gain.setValueAtTime(0, when);
        gn.gain.linearRampToValueAtTime(peak * envAt(env, t0b), when + atk);
        var lastT = when + atk;
        for (var ei = 0; ei < env.length; ei++) {
          var et = env[ei][0];
          if (et <= t0b || et >= t1b) continue;
          var f = (et - t0b) / dSpan;
          var tt = when + atk + f * body;
          if (tt <= lastT + 0.0005) continue;
          if (tt >= when + dur - 0.0005) break;
          gn.gain.linearRampToValueAtTime(peak * env[ei][1], tt);
          lastT = tt;
        }
        gn.gain.linearRampToValueAtTime(peak * envAt(env, t1b), when + dur);
        gn.gain.linearRampToValueAtTime(0, when + dur + 0.015);
      } catch (e) {
        try { gn.gain.cancelScheduledValues(when); } catch (e2) { }
        gn.gain.setValueAtTime(0, when);
        gn.gain.linearRampToValueAtTime(peak, when + atk);
        gn.gain.setValueAtTime(peak, when + sus);
        gn.gain.linearRampToValueAtTime(0, when + dur + 0.015);
      }'''

if old_env in j:
    j = j.replace(old_env, new_env, 1)
    print('sched env ok')
else:
    print('sched env NOT FOUND')

# ============================================================
# 5) 曲线拖完后，若正在播放则重排，立即生效
# ============================================================
old_up = '''    function envUp() {
      if (ENVD.drag < 0) return;
      /* 短按不动 = 想删？不删，保持简单 */
      ENVD.drag = -1;
    }'''
new_up = '''    function envUp() {
      if (ENVD.drag < 0) return;
      ENVD.drag = -1;
      if (S.playing) startPlayback(S.cursor || 0);
    }'''
if old_up in j:
    j = j.replace(old_up, new_up, 1)
    print('envup ok')
else:
    print('envup NOT FOUND')

io.open(APP, 'w', encoding='utf-8').write(j)
print('APP ok')