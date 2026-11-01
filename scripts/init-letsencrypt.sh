#!/bin/bash
# Run this script ONCE on the server to obtain the first certificate.
# Prerequisites: DOMAIN and LETSENCRYPT_EMAIL set in .env, port 80 open.
set -euo pipefail

# Load variables from .env
set -a; source .env; set +a

DOMAIN="${DOMAIN:?Imposta DOMAIN in .env (es. miodominio.example.com)}"
EMAIL="${LETSENCRYPT_EMAIL:?Imposta LETSENCRYPT_EMAIL in .env}"
STAGING="${LETSENCRYPT_STAGING:-0}"

CERT_PATH="./certbot/conf/live/$DOMAIN"

echo "==> Setting up HTTPS for: $DOMAIN"
mkdir -p "$CERT_PATH" ./certbot/www

# Create a temporary self-signed certificate so that nginx can start
echo "==> Temporary certificate..."
openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout "$CERT_PATH/privkey.pem" \
    -out "$CERT_PATH/fullchain.pem" \
    -subj "/CN=$DOMAIN" 2>/dev/null

# Start the stack with the temporary certificate
echo "==> Starting the backend..."
docker compose up -d backend

echo "==> Waiting for the backend to be healthy..."
until docker compose exec backend curl -sf http://localhost:5001/ > /dev/null 2>&1; do
    sleep 3
done

echo "==> Starting the frontend (nginx)..."
docker compose up -d frontend

sleep 5

# Remove the temporary certificate
rm -rf "$CERT_PATH"

# Obtain the real certificate through the ACME webroot challenge
STAGING_FLAG=""
[ "$STAGING" = "1" ] && STAGING_FLAG="--staging" && echo "==> STAGING MODE (no rate limit)"

echo "==> Requesting the Let's Encrypt certificate..."
docker compose run --rm certbot certonly \
    --webroot --webroot-path /var/www/certbot \
    --email "$EMAIL" \
    --domain "$DOMAIN" \
    --agree-tos --no-eff-email \
    --force-renewal \
    $STAGING_FLAG

# Reload nginx with the real certificate
echo "==> Reloading nginx..."
docker compose exec frontend nginx -s reload

echo ""
echo "=== Done! ==="
echo "Site available at: https://$DOMAIN"
echo ""
echo "Note: automatic renewal runs every 12 h through the certbot container."
echo "After each renewal, reload nginx by hand or add a cron job:"
echo "  0 0 * * 1 docker compose exec frontend nginx -s reload"
