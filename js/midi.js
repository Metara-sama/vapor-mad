/* ============================================================
   MIDI — 标准 MIDI 文件解析器（SMF format 0 / 1）
   ============================================================ */
(function (global) {
  'use strict';

  function Reader(buf) {
    this.d = new DataView(buf);
    this.p = 0;
    this.len = buf.byteLength;
  }
  Reader.prototype = {
    u8: function () {
      if (this.p >= this.len) throw new Error('eof');
      return this.d.getUint8(this.p++);
    },
    u16: function () { var v = this.d.getUint16(this.p); this.p += 2; return v; },
    u32: function () { var v = this.d.getUint32(this.p); this.p += 4; return v; },
    str: function (n) {
      var s = '';
      for (var i = 0; i < n; i++) s += String.fromCharCode(this.d.getUint8(this.p + i));
      this.p += n;
      return s;
    },
    skip: function (n) { this.p += n; },
    vlv: function () {
      var v = 0, b, guard = 0;
      do {
        if (this.p >= this.len) throw new Error('eof');
        b = this.d.getUint8(this.p++);
        v = (v << 7) | (b & 0x7f);
        if (++guard > 5) break;
      } while (b & 0x80);
      return v;
    }
  };

  /* 把 (tick) 映射到 (秒) 的函数 */
  function makeTickMapper(tempos, ppq, smpte) {
    if (smpte) {
      var tps = smpte.fps * smpte.tpf;
      if (tps <= 0) tps = 480;
      return function (t) { return t / tps; };
    }
    var segs = [];
    var tick = 0, sec = 0, us = 500000;
    for (var i = 0; i < tempos.length; i++) {
      var t = tempos[i];
      if (t.tick > tick) {
        var spt0 = (us / 1e6) / ppq;
        segs.push({ tick: tick, sec: sec, spt: spt0 });
        sec += (t.tick - tick) * spt0;
        tick = t.tick;
      }
      us = t.us;
    }
    segs.push({ tick: tick, sec: sec, spt: (us / 1e6) / ppq });
    return function (tk) {
      var lo = 0, hi = segs.length - 1;
      while (lo < hi) {
        var m = (lo + hi + 1) >> 1;
        if (segs[m].tick <= tk) lo = m; else hi = m - 1;
      }
      var s = segs[lo];
      return s.sec + (tk - s.tick) * s.spt;
    };
  }

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function noteName(p) {
    return NOTE_NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
  }
  function midiToFreq(p) { return 440 * Math.pow(2, (p - 69) / 12); }
  function freqToMidi(f) { return 69 + 12 * Math.log2(f / 440); }

  function parse(arrayBuffer) {
    var r = new Reader(arrayBuffer);
    if (r.str(4) !== 'MThd') throw new Error('不是 MIDI 文件');
    var hlen = r.u32();
    r.u16();                     // format
    var ntrks = r.u16();
    var division = r.u16();
    r.p = 8 + hlen;

    var ppq = 96, smpte = null;
    if (division & 0x8000) {
      var fps = 0x100 - (division >> 8);
      var tpf = division & 0xff;
      smpte = { fps: fps, tpf: tpf };
    } else {
      ppq = division || 96;
    }

    var rawTracks = [];
    var tempos = [];
    var guard = 0;

    while (r.p + 8 <= r.len && rawTracks.length < 64) {
      var id = r.str(4);
      var len = r.u32();
      var end = Math.min(r.p + len, r.len);
      if (id !== 'MTrk') { r.p = end; continue; }

      var notes = [];
      var nameParts = [];
      var open = Object.create(null);
      var tick = 0;
      var running = 0;
      var program = 0;
      var channel = 0;

      function closeNote(ch, pitch, tk) {
        var k = ch + ':' + pitch;
        var o = open[k];
        if (!o) return;
        delete open[k];
        var et = tk;
        if (et <= o.tick) et = o.tick + 1;
        notes.push({ pitch: o.pitch, tick: o.tick, endTick: et, vel: o.vel, ch: ch });
      }

      while (r.p < end) {
        if (++guard > 800000) break;
        var delta;
        try { delta = r.vlv(); } catch (e) { break; }
        tick += delta;

        var status = r.u8();
        if (status < 0x80) { r.p--; status = running; }
        else if (status < 0xF0) { running = status; }

        if (status === 0xF0 || status === 0xF7) {
          var sl = r.vlv();
          r.skip(sl);
          continue;
        }
        if (status === 0xFF) {
          var mtype = r.u8();
          var mlen = r.vlv();
          if (mtype === 0x51 && mlen === 3) {
            var us = (r.u8() << 16) | (r.u8() << 8) | r.u8();
            if (us > 1000) tempos.push({ tick: tick, us: us });
          } else if (mtype === 0x03 || mtype === 0x04) {
            var s = '';
            for (var i = 0; i < mlen; i++) s += String.fromCharCode(r.u8());
            nameParts.push(s.replace(/\0/g, ''));
          } else {
            r.skip(mlen);
          }
          continue;
        }

        var type = status >> 4;
        var ch = status & 0x0f;
        if (type === 0x9) {
          var p1 = r.u8(), v1 = r.u8();
          if (v1 === 0) closeNote(ch, p1, tick);
          else {
            var key = ch + ':' + p1;
            if (open[key]) closeNote(ch, p1, tick);
            open[key] = { pitch: p1, tick: tick, vel: v1 };
          }
          channel = ch;
        } else if (type === 0x8) {
          var p2 = r.u8(); r.u8();
          closeNote(ch, p2, tick);
        } else if (type === 0xA) { r.skip(2); }
        else if (type === 0xB) { r.skip(2); }
        else if (type === 0xC) { program = r.u8(); channel = ch; }
        else if (type === 0xD) { r.skip(1); }
        else if (type === 0xE) { r.skip(2); }
      }

      // 未闭合的音符收尾
      for (var k in open) {
        var o = open[k];
        notes.push({ pitch: o.pitch, tick: o.tick, endTick: tick + 1, vel: o.vel, ch: o.ch || 0 });
      }

      r.p = end;
      if (notes.length || nameParts.length) {
        rawTracks.push({
          name: (nameParts.find(function (x) { return x && x.trim(); }) || '').trim(),
          notes: notes,
          program: program,
          channel: channel
        });
      }
    }

    tempos.sort(function (a, b) { return a.tick - b.tick; });
    var map = makeTickMapper(tempos, ppq, smpte);

    var tracks = [];
    var duration = 0;
    for (var ti = 0; ti < rawTracks.length; ti++) {
      var tr = rawTracks[ti];
      if (!tr.notes.length) continue;
      var nn = [];
      for (var ni = 0; ni < tr.notes.length; ni++) {
        var n = tr.notes[ni];
        var s0 = map(n.tick);
        var s1 = map(n.endTick);
        if (!isFinite(s0) || !isFinite(s1)) continue;
        if (s1 - s0 < 0.008) s1 = s0 + 0.008;
        nn.push({ pitch: n.pitch, vel: n.vel, start: s0, end: s1 });
        if (s1 > duration) duration = s1;
      }
      if (!nn.length) continue;
      nn.sort(function (a, b) { return a.start - b.start; });
      tracks.push({
        name: tr.name || autoName(tracks.length, nn),
        notes: nn,
        program: tr.program,
        channel: tr.channel
      });
    }

    var baseUs = tempos.length ? tempos[0].us : 500000;
    return {
      tracks: tracks,
      duration: duration,
      ppq: ppq,
      beatSec: baseUs / 1e6,
      bpm: 60000000 / baseUs
    };
  }

  function autoName(idx, notes) {
    var lo = 127, hi = 0, sum = 0;
    for (var i = 0; i < notes.length; i++) {
      if (notes[i].pitch < lo) lo = notes[i].pitch;
      if (notes[i].pitch > hi) hi = notes[i].pitch;
      sum += notes[i].pitch;
    }
    var avg = Math.round(sum / notes.length);
    if (hi - lo <= 3) return noteName(avg);
    return 'CH ' + String(idx + 1).padStart(2, '0');
  }

  global.MIDI = {
    parse: parse,
    noteName: noteName,
    midiToFreq: midiToFreq,
    freqToMidi: freqToMidi
  };
})(window);