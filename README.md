# Photo Lens

Offline-first photo editor prototype: optical bokeh, telephoto compression, film looks.

## Run locally

```bash
cd web
npm install --legacy-peer-deps
npm run dev
```

Open http://127.0.0.1:5173/

## Stack

- Vite + React + TypeScript
- WebGL2 multi-pass pipeline (warp → disc bokeh → film)
- ONNX Runtime Web + Depth Anything V2 Small (Apache-2.0), model bundled under `web/public/models/`
- HEIC conversion via heic2any (lazy-loaded)

## License notes

See `docs/COMPLIANCE.md` (when present). Depth model weights: Apache-2.0.
Film looks are self-authored parametric grades (no third-party LUTs).
