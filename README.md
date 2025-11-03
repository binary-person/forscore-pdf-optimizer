# forscore-pdf-optimizer

https://forscore-pdf-optimizer.0110.lol

https://www.icloud.com/shortcuts/b11943c5fa2641458b9f46a809a05a95

How this works in a nutshell:
1. shrink DPI to 264-330. DPI 264 matches most iPads of 264 PPI
2. compress PDF to optimize file size further

reason for forscore loading very slowly is because typically, you get PDF files from IMSLP, and those PDF files can go around/above 1200DPI, which kills your iPad's performance. This simply reduces the PDF DPI to 264-300, which is still very high quality.

Behind-the-scenes in a nutshell:
1. Get ghostscript, [pdfsizeopt](https://github.com/pts/pdfsizeopt), and [https://github.com/aklomp/shrinkpdf/tree/master](shrinkpdf)
3. Run `./shrinkpdf.sh -r 264 -t 1.25 -g -o process1.pdf input.pdf`
4.  --use-pngout=no

To build+run:
Option A: docker compose up --build
Option B: docker build -t forscore-pdf-optimizer . && docker run --rm -p 3000:3000 forscore-pdf-optimizer
