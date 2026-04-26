# xtream-proxy

Proxy Node.js para queries a servers Xtream Codes que están detrás de Cloudflare/WAF.
Usa `got-scraping` para impersonar el TLS fingerprint de Chrome, evadiendo bloqueos
basados en JA3 que tumban a PHP cURL.

## Endpoints

- `GET /` — health check
- `GET /test?username=&password=&baseurl=` — request mínimo de prueba (live streams)
- `GET /buscador?username=&password=&baseurl=&tipoid=&search=` — proxy completo de búsqueda
  - `tipoid`: `0`/`all` (todos), `1` (live), `2` (movies), `3` (series)

## Run local

```
npm install
npm start
```

## Deploy en Hostinger Node.js Setup

1. Importar este repo desde GitHub.
2. Application root: la carpeta del repo.
3. Startup file: `server.js`.
4. Run NPM Install → Restart.
