/* ============================================================
   AUDIO — 缓冲区运算 / 变调 / 时间伸缩 / 效果渲染 / WAV 编码
   ============================================================ */
(function (global) {
  'use strict';

  var AU = {};
  AU.ctxRef = null;

  function makeBuffer(ch, len, sr) {
    len = Math.max(1, Math.round(len));
    if (AU.ctxRef) return AU.ctxRef.createBuffer(ch, len, sr);
    return new AudioBuffer({ numberOfChannels: ch, length: len, sampleRate: sr });
  }
  AU.makeBuffer = makeBuffer;

  /* ---------------- 峰值 ---------------- */
  AU.peaks = function (buffer, count) {
    var n = Math.max(8, count | 0);
    var ch = buffer.numberOfChannels;
    var data = [];
    for (var c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
    var len = buffer.length;
    var block = len / n;
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var s = Math.floor(i * block);
      var e = Math.min(len, Math.floor((i + 1) * block));
      var mx = 0;
      for (var j = s; j < e; j += 1) {
        for (var c2 = 0; c2 < ch; c2++) {
          var v = Math.abs(data[c2][j]);
          if (v > mx) mx = v;
        }
      }
      out[i] = mx;
    }
    return out;
  };

  /* ---------------- 重采样（线性插值） ---------------- */
  AU.resample = function (buffer, newLen) {
    newLen = Math.max(2, Math.round(newLen));
    var ch = buffer.numberOfChannels;
    var out = makeBuffer(ch, newLen, buffer.sampleRate);
    var ratio = (buffer.length - 1) / (newLen - 1);
    for (var c = 0; c < ch; c++) {
      var s = buffer.getChannelData(c);
      var d = out.getChannelData(c);
      for (var i = 0; i < newLen; i++) {
        var x = i * ratio;
        var x0 = x | 0;
        var x1 = x0 + 1 < s.length ? x0 + 1 : s.length - 1;
        var f = x - x0;
        d[i] = s[x0] * (1 - f) + s[x1] * f;
      }
    }
    return out;
  };

  /* ---------------- 时间伸缩（SOLA，音高不变） ---------------- */
  AU.timeStretch = function (buffer, factor) {
    if (Math.abs(factor - 1) < 0.002) return buffer;
    var ch = buffer.numberOfChannels;
    var sr = buffer.sampleRate;
    var inLen = buffer.length;
    var outLen = Math.max(64, Math.round(inLen * factor));
    var N = 1024, hop = N >> 1, ov = N - hop;
    var win = new Float32Array(N);
    for (var i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    var maxSearch = Math.min(hop, 192);

    var out = makeBuffer(ch, outLen, sr);
    for (var c = 0; c < ch; c++) {
      var src = buffer.getChannelData(c);
      var dst = out.getChannelData(c);
      var wsum = new Float32Array(outLen);
      var first = true;

      for (var op = 0; op < outLen; op += hop) {
        var baseIn = Math.round(op / factor);
        if (baseIn >= inLen) break;
        var inPos = baseIn;

        if (!first) {
          /* SOLA：在 ±maxSearch 内寻找与上一帧重叠区相关性最好的位置，锁住相位 */
          var bestD = 0, bestScore = -Infinity;
          for (var d = -maxSearch; d <= maxSearch; d += 2) {
            var p = baseIn + d;
            if (p < 0 || p + N > inLen) continue;
            var sc = 0;
            for (var k = 0; k < ov; k += 2) sc += src[p + k] * dst[op + k];
            if (sc > bestScore) { bestScore = sc; bestD = d; }
          }
          inPos = baseIn + bestD;
        } else {
          first = false;
        }

        if (inPos < 0) inPos = 0;
        if (inPos + N > inLen) inPos = Math.max(0, inLen - N);

        var lim = Math.min(N, inLen - inPos);
        for (var k2 = 0; k2 < lim; k2++) {
          var oi = op + k2;
          if (oi >= outLen) break;
          dst[oi] += src[inPos + k2] * win[k2];
          wsum[oi] += win[k2];
        }
      }
      for (var j = 0; j < outLen; j++) if (wsum[j] > 1e-4) dst[j] /= wsum[j];
    }
    return out;
  };

  /* ---------------- 变调（时长不变） ---------------- */
  AU.pitchShift = function (buffer, semitones) {
    if (!semitones) return buffer;
    var r = Math.pow(2, semitones / 12);
    var stretched = AU.timeStretch(buffer, r);
    return AU.resample(stretched, buffer.length);
  };

  /* ---------------- 位深压碎 ---------------- */
  AU.bitcrush = function (buffer, amt) {
    if (amt <= 0.001) return buffer;
    var bits = Math.max(2, Math.round(16 - amt * 13));
    var levels = Math.pow(2, bits);
    var decim = 1 + Math.round(amt * 6);
    var ch = buffer.numberOfChannels;
    var out = makeBuffer(ch, buffer.length, buffer.sampleRate);
    for (var c = 0; c < ch; c++) {
      var s = buffer.getChannelData(c);
      var d = out.getChannelData(c);
      var hold = 0;
      for (var i = 0; i < s.length; i++) {
        if (i % decim === 0) hold = Math.round(s[i] * levels) / levels;
        d[i] = hold;
      }
    }
    return out;
  };

  /* ---------------- 增益 ---------------- */
  AU.gainBuffer = function (buffer, g) {
    if (Math.abs(g - 1) < 0.001) return buffer;
    var ch = buffer.numberOfChannels;
    var out = makeBuffer(ch, buffer.length, buffer.sampleRate);
    for (var c = 0; c < ch; c++) {
      var s = buffer.getChannelData(c);
      var d = out.getChannelData(c);
      for (var i = 0; i < s.length; i++) d[i] = s[i] * g;
    }
    return out;
  };

  /* ---------------- 去掉开头静音（修 mp3 编码延迟） ---------------- */
  AU.trimHead = function (buffer, thr) {
    thr = thr || 0.005;
    var ch = buffer.numberOfChannels;
    var len = buffer.length;
    var first = len;
    for (var c = 0; c < ch; c++) {
      var d = buffer.getChannelData(c);
      for (var i = 0; i < len; i++) {
        if (Math.abs(d[i]) > thr) {
          if (i < first) first = i;
          break;
        }
      }
    }
    var maxTrim = Math.floor(buffer.sampleRate * 0.05);
    if (first <= 0 || first > maxTrim) return buffer;
    return AU.slice(buffer, first, len);
  };

  /* ---------------- 归一化 ---------------- */
  AU.normalize = function (buffer, target) {
    target = target || 0.94;
    var ch = buffer.numberOfChannels;
    var peak = 0;
    for (var c = 0; c < ch; c++) {
      var s = buffer.getChannelData(c);
      for (var i = 0; i < s.length; i++) {
        var v = Math.abs(s[i]);
        if (v > peak) peak = v;
      }
    }
    if (peak < 1e-5) return buffer;
    return AU.gainBuffer(buffer, target / peak);
  };

  /* ---------------- 反转 ---------------- */
  AU.reverse = function (buffer) {
    var ch = buffer.numberOfChannels;
    var len = buffer.length;
    var out = makeBuffer(ch, len, buffer.sampleRate);
    for (var c = 0; c < ch; c++) {
      var s = buffer.getChannelData(c);
      var d = out.getChannelData(c);
      for (var i = 0; i < len; i++) d[i] = s[len - 1 - i];
    }
    return out;
  };

  /* ---------------- 切片 ---------------- */
  AU.slice = function (buffer, fromSample, toSample) {
    var a = Math.max(0, Math.floor(fromSample));
    var b = Math.min(buffer.length, Math.floor(toSample));
    var len = Math.max(16, b - a);
    var ch = buffer.numberOfChannels;
    var out = makeBuffer(ch, len, buffer.sampleRate);
    for (var c = 0; c < ch; c++) {
      var s = buffer.getChannelData(c);
      var d = out.getChannelData(c);
      for (var i = 0; i < len; i++) d[i] = s[a + i] || 0;
    }
    return out;
  };

  /* ---------------- 删除区间 ---------------- */
  AU.removeRange = function (buffer, fromSample, toSample) {
    var a = Math.max(0, Math.floor(fromSample));
    var b = Math.min(buffer.length, Math.floor(toSample));
    if (b <= a) return buffer;
    var ch = buffer.numberOfChannels;
    var len = buffer.length - (b - a);
    var out = makeBuffer(ch, Math.max(16, len), buffer.sampleRate);
    for (var c = 0; c < ch; c++) {
      var s = buffer.getChannelData(c);
      var d = out.getChannelData(c);
      var o = 0;
      for (var i = 0; i < a; i++) d[o++] = s[i];
      for (var j = b; j < s.length; j++) d[o++] = s[j];
    }
    return out;
  };

  /* ---------------- 静音区间 ---------------- */
  AU.silence = function (buffer, fromSample, toSample) {
    var a = Math.max(0, Math.floor(fromSample));
    var b = Math.min(buffer.length, Math.floor(toSample));
    var ch = buffer.numberOfChannels;
    var out = makeBuffer(ch, buffer.length, buffer.sampleRate);
    for (var c = 0; c < ch; c++) {
      out.getChannelData(c).set(buffer.getChannelData(c));
    }
    var fade = Math.min(220, Math.floor((b - a) / 4) || 1);
    for (var c2 = 0; c2 < ch; c2++) {
      var d = out.getChannelData(c2);
      for (var i = a; i < b; i++) d[i] = 0;
    }
    return out;
  };

  /* ---------------- 淡入淡出 ---------------- */
  AU.fade = function (buffer, fromSample, toSample, dir) {
    var a = Math.max(0, Math.floor(fromSample));
    var b = Math.min(buffer.length, Math.floor(toSample));
    var n = Math.max(2, b - a);
    var ch = buffer.numberOfChannels;
    var out = makeBuffer(ch, buffer.length, buffer.sampleRate);
    for (var c = 0; c < ch; c++) {
      out.getChannelData(c).set(buffer.getChannelData(c));
    }
    for (var c2 = 0; c2 < ch; c2++) {
      var d = out.getChannelData(c2);
      for (var i = a; i < b; i++) {
        var t = (i - a) / n;
        d[i] *= dir > 0 ? t : 1 - t;
      }
    }
    return out;
  };

  /* ---------------- 失真曲线 ---------------- */
  function distCurve(amount) {
    var n = 2048, curve = new Float32Array(n);
    var k = amount * 70;
    for (var i = 0; i < n; i++) {
      var x = i * 2 / n - 1;
      curve[i] = (1 + k) * x / (1 + k * Math.abs(x));
    }
    return curve;
  }
  AU.distCurve = distCurve;

  /* ---------------- 脉冲响应 ---------------- */
  function makeImpulse(ctx, seconds, decay) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c);
      for (var i = 0; i < len; i++) {
        var t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (1 - t * 0.2);
      }
    }
    return buf;
  }
  AU.makeImpulse = makeImpulse;

  /* ---------------- 效果链离线渲染 ---------------- */
  AU.renderFx = async function (buffer, p) {
    var b = buffer;
    if (p.pitch) b = AU.pitchShift(b, p.pitch);
    if (p.bitcrush > 0.001) b = AU.bitcrush(b, p.bitcrush);
    if (p.gain !== 1) b = AU.gainBuffer(b, p.gain);

    var ch = Math.min(2, b.numberOfChannels);
    var sr = b.sampleRate;
    var speed = p.speed || 1;
    var tail = 0;
    if (p.delayTime > 0) tail += Math.min(p.delayTime * 7, 4);
    if (p.reverb > 0) tail += 2.2;
    var outDur = b.duration / speed + tail;

    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var oc = new OAC(ch, Math.max(256, Math.ceil(outDur * sr)), sr);

    var src = oc.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = speed;
    var node = src;

    function push(n) { node.connect(n); node = n; return n; }

    if (p.highpass > 22) {
      var hp = oc.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = p.highpass;
      hp.Q.value = 0.6;
      push(hp);
    }
    if (p.lowpass < 19500) {
      var lp = oc.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = p.lowpass;
      lp.Q.value = 0.9;
      push(lp);
    }
    if (p.drive > 0.001) {
      var ws = oc.createWaveShaper();
      ws.curve = distCurve(p.drive);
      ws.oversample = '2x';
      push(ws);
      var mk = oc.createGain();
      mk.gain.value = 1 / (1 + p.drive * 1.4);
      push(mk);
    }
    if (p.delayTime > 0) {
      var dryG = oc.createGain(), wetG = oc.createGain(), sum = oc.createGain();
      dryG.gain.value = 1 - p.reverb * 0.3;
      wetG.gain.value = 0.62;
      node.connect(dryG); dryG.connect(sum);
      var dl = oc.createDelay(4);
      dl.delayTime.value = Math.min(p.delayTime, 3.9);
      var fb = oc.createGain();
      fb.gain.value = Math.min(p.delayFb, 0.86);
      var fbLp = oc.createBiquadFilter();
      fbLp.type = 'lowpass';
      fbLp.frequency.value = 3400;
      node.connect(dl); dl.connect(fbLp); fbLp.connect(fb); fb.connect(dl);
      dl.connect(wetG); wetG.connect(sum);
      node = sum;
    }
    if (p.reverb > 0.001) {
      var conv = oc.createConvolver();
      conv.buffer = makeImpulse(oc, 2.0, 3.0);
      var rdry = oc.createGain(), rwet = oc.createGain(), rsum = oc.createGain();
      rdry.gain.value = 1 - p.reverb * 0.35;
      rwet.gain.value = p.reverb * 0.95;
      node.connect(rdry); rdry.connect(rsum);
      node.connect(conv); conv.connect(rwet); rwet.connect(rsum);
      node = rsum;
    }

    var fade = oc.createGain();
    fade.gain.setValueAtTime(0, 0);
    fade.gain.linearRampToValueAtTime(1, 0.004);
    fade.gain.setValueAtTime(1, Math.max(0.006, outDur - 0.02));
    fade.gain.linearRampToValueAtTime(0, outDur);
    push(fade);

    node.connect(oc.destination);
    src.start(0);
    var rendered = await oc.startRendering();
    return trimTail(rendered);
  };

  /* 去掉末尾无效尾巴，避免采样时长虚高 */
  function trimTail(buffer) {
    var ch = buffer.numberOfChannels;
    var len = buffer.length;
    var thr = 0.0018;
    var last = 0;
    for (var c = 0; c < ch; c++) {
      var d = buffer.getChannelData(c);
      for (var i = len - 1; i >= 0; i--) {
        if (Math.abs(d[i]) > thr) { if (i > last) last = i; break; }
      }
    }
    var pad = Math.floor(buffer.sampleRate * 0.06);
    var end = Math.min(len, last + pad + 1);
    if (end < buffer.sampleRate * 0.02) return buffer;
    if (end >= len) return buffer;
    return AU.slice(buffer, 0, end);
  }
  AU.trimTail = trimTail;

  /* ---------------- WAV 编码 ---------------- */
  AU.encodeWav = function (buffer) {
    var numCh = Math.min(2, buffer.numberOfChannels);
    var len = buffer.length;
    var dataLen = len * numCh * 2;
    var ab = new ArrayBuffer(44 + dataLen);
    var dv = new DataView(ab);
    var o = 0;
    function wStr(s) { for (var i = 0; i < s.length; i++) dv.setUint8(o++, s.charCodeAt(i)); }
    function wU32(v) { dv.setUint32(o, v, true); o += 4; }
    function wU16(v) { dv.setUint16(o, v, true); o += 2; }
    wStr('RIFF'); wU32(36 + dataLen); wStr('WAVE');
    wStr('fmt '); wU32(16); wU16(1); wU16(numCh);
    wU32(buffer.sampleRate);
    wU32(buffer.sampleRate * numCh * 2);
    wU16(numCh * 2); wU16(16);
    wStr('data'); wU32(dataLen);
    var chans = [];
    for (var c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
    for (var i = 0; i < len; i++) {
      for (var c2 = 0; c2 < numCh; c2++) {
        var s = chans[c2][i];
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  };

  /* ---------------- 基频检测（自相关） ---------------- */
  AU.detectPitch = function (buffer) {
    var src = buffer.getChannelData(0);
    var sr = buffer.sampleRate;
    var W = 2048;
    if (src.length < W * 2) W = Math.max(512, Math.floor(src.length / 2));

    var bestPos = 0, bestE = -1;
    var probes = 20;
    for (var i = 0; i < probes; i++) {
      var p = Math.floor((src.length - W) * (i / probes));
      if (p < 0) continue;
      var e = 0;
      for (var k = 0; k < W; k += 4) { var v = src[p + k]; e += v * v; }
      if (e > bestE) { bestE = e; bestPos = p; }
    }

    var buf = new Float32Array(W);
    for (var j = 0; j < W; j++) buf[j] = src[bestPos + j] || 0;

    var rms = 0;
    for (var r = 0; r < W; r++) rms += buf[r] * buf[r];
    rms = Math.sqrt(rms / W);
    if (rms < 0.004) return -1;

    var minLag = Math.max(2, Math.floor(sr / 1600));
    var maxLag = Math.min(W - 2, Math.floor(sr / 45));
    var r = new Float32Array(maxLag + 2);
    var peakVal = 0;
    for (var lag = minLag; lag <= maxLag; lag++) {
      var s1 = 0, s2 = 0, sum = 0;
      for (var m = 0; m < W - lag; m += 2) {
        sum += buf[m] * buf[m + lag];
        s1 += buf[m] * buf[m];
        s2 += buf[m + lag] * buf[m + lag];
      }
      var val = sum / Math.sqrt(s1 * s2 + 1e-9);
      r[lag] = val;
      if (val > peakVal) peakVal = val;
    }
    if (peakVal < 0.4) return -1;

    /* 取第一个超过阈值的局部峰 → 基频周期（避免选到整数倍周期造成低八度错误） */
    var thresh = peakVal * 0.86;
    var bestLag = -1;
    for (var L = minLag + 1; L < maxLag; L++) {
      if (r[L] >= thresh && r[L] >= r[L - 1] && r[L] >= r[L + 1]) { bestLag = L; break; }
    }
    if (bestLag < 0) {
      for (var L2 = minLag; L2 <= maxLag; L2++) if (r[L2] === peakVal) { bestLag = L2; break; }
    }
    if (bestLag < 0) return -1;

    /* 抛物线插值提高精度 */
    var x1 = r[bestLag - 1] || 0, x2 = r[bestLag], x3 = r[bestLag + 1] || 0;
    var den = x1 - 2 * x2 + x3;
    var lagF = bestLag;
    if (Math.abs(den) > 1e-9) lagF = bestLag + 0.5 * (x1 - x3) / den;
    if (lagF < 1) lagF = bestLag;

    var freq = sr / lagF;
    if (freq < 40 || freq > 1800) return -1;
    return 69 + 12 * Math.log2(freq / 440);
  };

  global.AU = AU;
})(window);