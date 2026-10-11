# assets/ — the reduced renderer's inputs

The open-source build (`RENDERER` unset or `public`) draws **one airport: New York JFK (KJFK)**. `books/KJFK/book.html` is
that airport's book with the placeholder name `Zzchildzz`; a proof swaps the child's name in, and the paid-for PDF is printed
from the same page with **SAMPLE** watermarked across every page. The AtlasOfOne production pipeline (all airports,
clean PDFs) is not in this repository; `RENDERER=private` + `PIPELINE_ROOT` points the shop at it.

| Path | What | License |
|---|---|---|
| `books/KJFK/book.html` | sample book (layout, mazes, art) | © Hun AI Lab — CC BY-NC 4.0 |
| map geometry inside it | taxiways, runways, aprons | © OpenStreetMap contributors, ODbL 1.0 (credited on every page) |
| `fonts/*.woff2` | Barlow, Barlow Condensed | SIL Open Font License 1.1 — `fonts/OFL.txt` |

The code in this repository is MIT (`../LICENSE`).
