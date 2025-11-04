# forscore-pdf-optimizer

https://forscore-pdf-optimizer.0110.lol

https://www.icloud.com/shortcuts/fd2240209d5c4264b792cd4be398a9a2

(use this one if you don't need the iOS shortcut functionality) https://laurentmmeyer.github.io/ghostscript-pdf-compress.wasm/

ForScore loads slow because the PDF files you'd get from IMSLP are incredibly high quality scans, and those PDF files can go around/above 1200DPI, which kills your iPad's performance. Ghostscript (run in the server) uses ebook compression settings that reduces the DPI to <300, which is still very high quality.


## Notes and better alternatives

The underlying command is taken from https://github.com/laurentmmeyer/ghostscript-pdf-compress.wasm which is actually better than this project, if you don't need the iOS shortcut, because the actual compression doesn't send any data to the server.

I tried my best to think of a way where we can locally compress PDFs using the ghostscript binary with iOS shortcuts, but unfortunately, it is extremely hard to do so.

Please use this one instead if you don't need that functionality: https://laurentmmeyer.github.io/ghostscript-pdf-compress.wasm

## To build+run:
Option A: docker compose up --build
Option B: docker build -t forscore-pdf-optimizer . && docker run --rm -p 3000:3000 forscore-pdf-optimizer
