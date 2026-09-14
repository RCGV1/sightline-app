# Sightline — production Dockerfile
FROM python:3.12.8-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# System deps for rasterio/GDAL, pyproj, Pillow, scipy
RUN apt-get update && apt-get install -y --no-install-recommends \
    gdal-bin \
    libgdal-dev \
    libproj-dev \
    proj-bin \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first for layer caching
COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

# Copy app
COPY . .

# Ensure data dir exists (scene .npz shipped; cache written at runtime)
RUN mkdir -p data/cache data/ept-cache && useradd -m app && chown -R app /app

USER app

# Production env: bind 0.0.0.0, allow any host by default
ENV HOST=0.0.0.0 \
    PORT=8000 \
    PUBLISHED=1

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os, urllib.request; p=os.getenv('PORT','8000'); urllib.request.urlopen(f'http://127.0.0.1:{p}/api/health', timeout=5).read()"

CMD ["python", "server.py"]
