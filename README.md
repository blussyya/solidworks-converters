# sldprt

Reads SolidWorks part files (.SLDPRT) without SolidWorks and turns them into STL or STEP. It's plain Node, no dependencies, Node 18 or newer.

The STEP comes straight from the Parasolid body stored inside the part, so planes, cylinders, cones, B-spline faces and their edges come out as the exact geometry the file holds. It doesn't re-fit anything from the display mesh. STL comes from the display mesh SolidWorks saves in the part, and the body is only triangulated when a part has no display mesh.

It reads modern parts (SolidWorks 2015 and later) and the older OLE2 parts from SolidWorks 2011.

## Install

```bash
npm install -g github:blussyya/solidworks-converters
```

Or clone it and run `node bin/sldprt.js` from the folder.

## Convert a part

```bash
sldprt convert part.SLDPRT
```

With no flags it writes `part.converted.stl` and `part.converted.step` next to the input. Pick one or name the output:

```bash
sldprt convert part.SLDPRT --step out.step --stl out.stl --ascii
```

`--mesh` writes STEP from the display mesh instead (planes stay exact, everything else becomes triangles), and `--faceted` makes it all triangles. `--scale N` applies to STL and mesh STEP. Exact STEP is always in millimetres.

If the converter can't hit the tolerance on a face, it stops with an error instead of writing a mesh that's quietly wrong.

## Other commands

- `sldprt info part.SLDPRT` shows the container, streams, which SolidWorks version saved it and which one created it, and a count of the B-rep. Add `--json` for machine output.
- `sldprt brep part.SLDPRT --volume` prints the native body's node census and its exact volume.
- `sldprt render part.SLDPRT out.png` makes a six-view PNG of the display mesh.
- `sldprt view part.SLDPRT` opens a viewer in a truecolor terminal.
- `sldprt serve --open` starts a browser viewer at `/web/index.html`.

Files over the built-in section size limit get refused. If you trust the file, `--allow-large-sections` on `info`, `brep` or `convert` lets it through.

## Inspect the B-rep

```bash
sldprt inspect part.SLDPRT [--port 8081] [--host 127.0.0.1] [--open]
```

Starts a local page for checking geometry against the exact B-rep. Pick a face from the list (search by id or type) and it's drawn over the display mesh: the stored surface patch in blue, and for B-splines and offsets of B-splines a band past the stored range in orange. Vertices are dots. For a blend face you get its spine's surfaces, the stored chart points joined by a black line, and the spine's start and end. Orbit, pan and zoom with the mouse; the mesh can be shaded, translucent or hidden.

It does no surface fitting, so anything it can't evaluate (blend surfaces themselves, some intersection curves) is skipped and listed under "Could not be evaluated". Clicking the mesh selects a B-rep face only when the file's display faces carry B-rep face ids (modern files do, the SW2011 ones don't); the page says which. Needs only Node, and nothing leaves your machine.

## Optional setup

`npm run setup` asks "Do you want the full validation suite? (y/N)". Yes runs `python3 -m pip install --user cadquery-ocp`, which `tools/validate.js` and `tools/validate-step.py` use to re-open our STEP output in OpenCascade. No changes nothing. It never runs on `npm install`, and the converter and `sldprt inspect` don't need it.

## From code

```js
const sldprt = require('sldprt');

const info = sldprt.info('part.SLDPRT');
const { volume } = sldprt.volume('part.SLDPRT'); // m³
```

`toSTL`, `toSTEP`, `readBrep` and `parse` are exported too. `src/index.js` has the full list.

## How exact is it

The volume test checks two cylinders crossed at right angles against the closed form 2πr²L − 16r³/3, and we match it to better than 1e-13. SolidWorks' own STEP export is 2.1e-8 off on the same part because it writes the intersection curves as B-splines.

Some parts still don't come out right. On 32 parts from the community set the triangulator leaves gaps, and 5 parts don't resolve at all. Both are on the list to fix.

## Tests

```bash
npm test
```

Some tests need the test corpus. Clone sldprt-research-dump next to this repo or set `SLDPRT_CORPUS`, otherwise those tests get skipped.

## License

Apache 2.0. See `LICENSE` and `NOTICE`.
