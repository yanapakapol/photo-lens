/** Minimal JPEG EXIF reader: focal length, f-number, exposure time, ISO.
 *  Only walks APP1 TIFF IFD; enough for phone photos. MIT-style original. */

export interface ExifPhoto {
  focalMm: number | null;
  fNumber: number | null;
  exposureSec: number | null;
  iso: number | null;
}

export function parseExif(file: Blob): Promise<ExifPhoto> {
  return new Promise(async (resolve) => {
    const empty: ExifPhoto = {
      focalMm: null,
      fNumber: null,
      exposureSec: null,
      iso: null,
    };
    try {
      const buf = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
      if (buf[0] !== 0xff || buf[1] !== 0xd8) return resolve(empty);
      let off = 2;
      while (off + 4 < buf.length) {
        if (buf[off] !== 0xff) break;
        const marker = buf[off + 1];
        const size = (buf[off + 2] << 8) | buf[off + 3];
        if (marker === 0xe1 && buf[off + 4] === 0x45 && buf[off + 5] === 0x78) {
          // "Exif"
          return resolve(readTiff(buf, off + 10));
        }
        if (marker === 0xda) break; // SOS
        off += 2 + size;
      }
    } catch {
      /* fall through */
    }
    resolve(empty);
  });
}

function readTiff(buf: Uint8Array, base: number): ExifPhoto {
  const out: ExifPhoto = {
    focalMm: null,
    fNumber: null,
    exposureSec: null,
    iso: null,
  };
  if (base + 8 > buf.length) return out;
  const le = buf[base] === 0x49;
  const u16 = (o: number) =>
    le ? buf[o] | (buf[o + 1] << 8) : (buf[o] << 8) | buf[o + 1];
  const u32 = (o: number) =>
    le
      ? buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)
      : (buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3];

  const ifd0 = base + u32(base + 4);
  const readIfd = (start: number, tags: Record<number, (v: number, type: number) => void>) => {
    if (start < 0 || start + 2 > buf.length) return;
    const count = u16(start);
    for (let i = 0; i < count; i++) {
      const e = start + 2 + i * 12;
      if (e + 12 > buf.length) return;
      const tag = u16(e);
      const type = u16(e + 2);
      const num = u32(e + 4);
      const handler = tags[tag];
      if (!handler) continue;
      // Value inline if ≤4 bytes
      if (type === 3 && num === 1) handler(u16(e + 8), type); // SHORT
      else if (type === 4 && num === 1) handler(u32(e + 8), type); // LONG
      else if (type === 5 && num === 1) {
        const rat = base + u32(e + 8);
        const r = u32(rat) / (u32(rat + 4) || 1);
        handler(r, type);
      } else if (type === 3 && num === 2) {
        // two shorts: take first (e.g. ISO often type 3 num 1; ExifIFD pointer separate)
        handler(u16(e + 8), type);
      } else if (type === 4 && num === 1) handler(u32(e + 8), type);
    }
  };

  // IFD0: ExifIFD pointer tag 0x8769
  let exifIfd = 0;
  readIfd(ifd0, {
    0x8769: (v) => {
      exifIfd = base + v;
    },
  });
  if (exifIfd) {
    readIfd(exifIfd, {
      0x920a: (v) => {
        out.focalMm = v;
      }, // FocalLength
      0x829d: (v) => {
        out.fNumber = v;
      }, // FNumber
      0x829a: (v) => {
        out.exposureSec = v;
      }, // ExposureTime
      0x8827: (v) => {
        out.iso = v;
      }, // ISO
    });
  }
  return out;
}
