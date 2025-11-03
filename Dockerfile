FROM node:20-bookworm-slim

# System deps for PDF tooling
RUN apt-get update && apt-get install -y --no-install-recommends \
    ghostscript qpdf wget python3 tar gzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install pdfsizeopt (per your instructions)
RUN mkdir -p /opt/pdfsizeopt && cd /opt/pdfsizeopt \
 && wget -O pdfsizeopt_libexec_linux.tar.gz https://github.com/pts/pdfsizeopt/releases/download/2023-04-18/pdfsizeopt_libexec_linux-v9.tar.gz \
 && tar xzvf pdfsizeopt_libexec_linux.tar.gz \
 && rm -f pdfsizeopt_libexec_linux.tar.gz \
 && wget -O pdfsizeopt.single https://raw.githubusercontent.com/pts/pdfsizeopt/master/pdfsizeopt.single \
 && chmod +x pdfsizeopt.single \
 && ln -s /opt/pdfsizeopt/pdfsizeopt.single /usr/local/bin/pdfsizeopt

# Install shrinkpdf.sh
RUN mkdir -p /opt/shrinkpdf \
 && wget -O /opt/shrinkpdf/shrinkpdf.sh https://raw.githubusercontent.com/aklomp/shrinkpdf/master/shrinkpdf.sh \
 && chmod +x /opt/shrinkpdf/shrinkpdf.sh

# App setup
WORKDIR /app
COPY package.json /app/package.json
COPY package-lock.json /app/package-lock.json
RUN npm ci
COPY index.js /app/index.js
RUN mkdir -p /app/public
COPY index.html /app/public/index.html

EXPOSE 3000
CMD ["node", "index.js"]