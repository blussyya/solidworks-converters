/* Modern SLDPRT container (SolidWorks 2015+): stream discovery, decompression and CRC check.
 *
 * Isomorphic (Node + browser). Decompressors are injected so the file has no dependencies:
 * Node passes zlib.inflateRawSync / zlib.inflateSync, the browser passes src/inflate.js.
 * Each must be function(bytes) -> bytes and throw on failure.
 *
 * Every stream is preceded by a 30-byte header whose field positions coincide with a ZIP local
 * file header (see docs/format/container.md):
 *
 *   +0   u32  per-file signature (constant within a file, different between files)
 *   +4   u16  20        +6 u16 6        +8 u16 8 (deflate)   <- the 6-byte pattern scanned for
 *   +14  u32  CRC-32 of the inflated stream
 *   +18  u32  compressed size
 *   +22  u32  inflated size
 *   +26  u16  name length       +28 u16 extra length (0)
 *   +30  name, each byte rotated left by (file byte 7 & 7) bits; then raw DEFLATE data
 *
 * The file is a ZIP archive in disguise (EXP-112). After the 8-byte file header come the local
 * records above, then a central directory and an end record laid out as in ZIP, with three
 * differences: the three signatures are per-file values instead of PK\3\4, PK\1\2 and PK\5\6, every
 * stored offset is counted from byte 8, and blocks of filler that imitate headers and end
 * records sit between the real ones. readDirectory() finds the real end record by the one
 * property the imitations lack: it sits exactly where its own directory offset and size say the
 * directory ends, and that directory's records and the headers they point to are consistent.
 *
 * decompressOpenSX() reads through the directory. Without one (a truncated file) it falls back
 * to scanning for the 6-byte pattern, which also hits the filler and compressed data. Those
 * false hits decode to non-printable names; only printable names are CRC-checked, and a
 * printable-named stream that inflates but fails its CRC is an error.
 *
 * Code moved verbatim from parser/v0.1's container reader (with the 2026-09-26 CRC check).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SLDPRTModern = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function toUint8(bufLike) {
    if (bufLike instanceof Uint8Array) return bufLike;
    return new Uint8Array(bufLike);
  }

  function toDataView(bufLike) {
    var u8 = toUint8(bufLike);
    return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }

  function findAll(u8, pattern) {
    var r = [];
    var plen = pattern.length;
    var limit = u8.length - plen;
    for (var i = 0; i <= limit; i++) {
      var ok = true;
      for (var j = 0; j < plen; j++) {
        if (u8[i + j] !== pattern[j]) { ok = false; break; }
      }
      if (ok) r.push(i);
    }
    return r;
  }

  function rolByte(b, s) {
    s &= 7;
    if (!s) return b;
    return ((b << s) | (b >>> (8 - s))) & 0xFF;
  }

  function crc32(bytes) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (var k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /* Legacy files are OLE2 compound documents; everything else is treated as modern. */
  function isOLE2(buffer) {
    var u8 = toUint8(buffer);
    return u8.length >= 4 && u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0;
  }

  var BASE = 8;   // stored offsets are counted from the end of the 8-byte file header

  /* Walks `count` central records starting at file offset `p`. Returns the entries, or null as
   * soon as something doesn't fit: a record with another signature, a header that doesn't repeat
   * its record, data that runs off the end. */
  function walkDirectory(buf, dv, p, count, end) {
    var key = buf[7], entries = [], csig = 0, lsig = 0;
    for (var k = 0; k < count; k++) {
      if (p + 46 > end) return null;
      var sig = dv.getUint32(p, true);
      if (k === 0) csig = sig; else if (sig !== csig) return null;
      if (dv.getUint16(p + 6, true) !== 20 || dv.getUint16(p + 10, true) !== 8) return null;
      var nameSize = dv.getUint16(p + 28, true);
      var recEnd = p + 46 + nameSize + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
      if (recEnd > end) return null;
      var h = dv.getUint32(p + 42, true) + BASE;
      if (h + 30 + nameSize > buf.length) return null;
      var ls = dv.getUint32(h, true);
      if (k === 0) lsig = ls; else if (ls !== lsig) return null;
      // the header repeats the record's CRC, sizes and name
      if (dv.getUint32(h + 14, true) !== dv.getUint32(p + 16, true) ||
          dv.getUint32(h + 18, true) !== dv.getUint32(p + 20, true) ||
          dv.getUint32(h + 22, true) !== dv.getUint32(p + 24, true) ||
          dv.getUint16(h + 26, true) !== nameSize) return null;
      var name = '';
      for (var i = 0; i < nameSize; i++) {
        if (buf[h + 30 + i] !== buf[p + 46 + i]) return null;
        name += String.fromCharCode(rolByte(buf[p + 46 + i], key));
      }
      var dataStart = h + 30 + nameSize + dv.getUint16(h + 28, true);
      var compSize = dv.getUint32(p + 20, true);
      if (dataStart + compSize > buf.length) return null;
      entries.push({ name: name, crc: dv.getUint32(p + 16, true), compSize: compSize,
        size: dv.getUint32(p + 24, true), dataStart: dataStart, header: h });
      p = recEnd;
    }
    return entries;
  }

  /* The file's directory: [{name, crc, compSize, size, dataStart, header}] in stored order, or
   * null when the file has none. An end record is 4 signature bytes, 4 zero bytes, the entry
   * count twice (u16), the directory's size and offset (u32), and a zero u16. The real one sits
   * at BASE + offset + size; the imitations around it don't. */
  function readDirectory(buffer) {
    var buf = toUint8(buffer);
    var dv = toDataView(buf);
    for (var at = buf.length - 22; at >= BASE; at--) {
      if (buf[at + 4] | buf[at + 5] | buf[at + 6] | buf[at + 7] | buf[at + 20] | buf[at + 21]) continue;
      var count = dv.getUint16(at + 8, true);
      if (!count || count !== dv.getUint16(at + 10, true)) continue;
      var size = dv.getUint32(at + 12, true), off = dv.getUint32(at + 16, true);
      if (BASE + off + size !== at) continue;
      var entries = walkDirectory(buf, dv, BASE + off, count, at);
      if (entries) return entries;
    }
    return null;
  }

  function inflateEntries(buf, entries, inflateRaw) {
    var streams = {};
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.size === 0) continue;   // empty streams are left out, as the scan leaves them out
      if (e.compSize > 50e6) throw Error('stream ' + e.name + ' is too large');
      var data = inflateRaw(buf.subarray(e.dataStart, e.dataStart + e.compSize));
      if (data.length !== e.size) throw Error('wrong inflated size in stream ' + e.name);
      if (crc32(data) !== e.crc) throw Error('CRC-32 mismatch in stream ' + e.name);
      if (!streams[e.name]) streams[e.name] = data;
    }
    return streams;
  }

  /* Returns {name: inflatedBytes} for every nonempty stream. The first occurrence of a name
   * wins. */
  function decompressOpenSX(buffer, inflateRaw, inflateZlib) {
    var buf = toUint8(buffer);
    var entries = readDirectory(buf);
    if (entries) return inflateEntries(buf, entries, inflateRaw);
    return scanOpenSX(buf, inflateRaw, inflateZlib);
  }

  /* The fallback for a file without a readable directory: scan for stream headers. */
  function scanOpenSX(buffer, inflateRaw, inflateZlib) {
    var buf = toUint8(buffer);
    var dv = toDataView(buf);
    var key = buf[7];
    var magic = [20, 0, 6, 0, 8, 0];
    var streams = {};
    var matches = findAll(buf, magic);

    for (var mi = 0; mi < matches.length; mi++) {
      var matchPos = matches[mi];
      var sigStart = matchPos - 4;
      if (sigStart < 0 || sigStart + 30 > buf.length) continue;

      var compSize = dv.getUint32(sigStart + 18, true);
      var nameSize = dv.getUint32(sigStart + 26, true);

      if (nameSize > 1024 || compSize > 50e6) continue;

      var nameStart = sigStart + 30;
      var dataStart = nameStart + nameSize;
      var dataEnd = dataStart + compSize;

      if (dataEnd > buf.length) continue;

      if (compSize > 0) {
        var name = '';
        for (var i = 0; i < nameSize; i++) {
          name += String.fromCharCode(rolByte(buf[nameStart + i], key));
        }
        if (!name) continue;

        var slice = buf.subarray(dataStart, dataEnd);
        var data = null;
        try {
          data = inflateRaw(slice);
        } catch (e) {
          try {
            data = inflateZlib(slice);
          } catch (e2) { /* leave data null */ }
        }

        // A real stream inflates to exactly the size at +22. Directory-like records elsewhere in
        // the file reuse a stream's name but not its sizes, and can inflate to junk.
        if (data && data.length !== dv.getUint32(sigStart + 22, true)) data = null;
        if (data && data.length > 0) {
          // header+14 is the CRC-32 of the inflated bytes (1,730/1,730 named streams). The
          // six-byte signature also occurs inside unrelated data; those false hits carry
          // non-printable decoded names and must not be reported as corruption.
          var declaredCrc = dv.getUint32(sigStart + 14, true);
          if (/^[\x20-\x7e]+$/.test(name) && crc32(data) !== declaredCrc)
            throw Error('CRC-32 mismatch in stream ' + name);
        }
        if (data && data.length > 0 && !streams[name]) {
          streams[name] = data;
        }
      }
    }

    return streams;
  }

  /* The DisplayLists stream: a stream whose name contains "displaylist", longer than 100 bytes,
   * starting with u32 [1, 1]. */
  function findDisplayLists(buffer, inflateRaw, inflateZlib) {
    return pickDisplayLists(decompressOpenSX(buffer, inflateRaw, inflateZlib));
  }

  function pickDisplayLists(streams) {
    var names = Object.keys(streams);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var data = streams[name];
      if (name.toLowerCase().indexOf('displaylist') !== -1 && data.length > 100) {
        var dv = toDataView(data);
        if (dv.getUint32(0, true) === 1 && dv.getUint32(4, true) === 1) {
          return data;
        }
      }
    }
    return null;
  }

  /* The declared DisplayLists version is carried as the *name* of a stream, e.g.
   * "..._DL_VERSION_15000". Returns the number, or null. */
  function displayListsVersion(streams) {
    var names = Object.keys(streams);
    for (var i = 0; i < names.length; i++) {
      var m = /_DL_VERSION_(\d+)/.exec(names[i]);
      if (m) return Number(m[1]);
    }
    return null;
  }

  return {
    findAll: findAll,
    isOLE2: isOLE2,
    crc32: crc32,
    readDirectory: readDirectory,
    decompressOpenSX: decompressOpenSX,
    scanOpenSX: scanOpenSX,
    findDisplayLists: findDisplayLists,
    pickDisplayLists: pickDisplayLists,
    displayListsVersion: displayListsVersion,
  };
});
