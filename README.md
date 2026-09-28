# The Cake Co. (TCC)

Luxury storefront for The Cake Co., Mattoor, Kalady, with an owner Menu Studio.

## Run it

```bash
npm install
ADMIN_PASSWORD='choose-a-strong-password' npm start
```

- Storefront: http://localhost:3000
- Menu Studio: http://localhost:3000/admin

If you start without `ADMIN_PASSWORD` in development, the server prints a temporary password in the terminal. In production it refuses to start without one.

## Files

- `server.js`: Express server, menu API, sign-in, security headers.
- `public/index.html`: the storefront, including the 3D cake and cursor.
- `public/admin.html`: the owner's Menu Studio.
- `data/menu.json`: created automatically on first run with the four signature cakes. Back this file up.

## For the owner

- Type prices as numbers only, like `1500`. The storefront shows `₹1,500/kg`, `₹1,500/box` and so on, based on the category.
- Leave the price empty to show "Price on request".
- Drop a photo onto the upload box or paste an image link. Photos are resized automatically.
- Tap the bin icon to delete. You have 7 seconds to undo.
- To change a price on an existing cake, delete it and add it again.

## Deploying

Use a Node host with a persistent disk (Render with a disk, Railway, Fly.io or a VPS) so `data/menu.json` survives restarts. Set the variables in `.env.example`. Put the site behind Cloudflare's free plan for DDoS protection.
