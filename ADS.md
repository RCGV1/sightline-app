# Adding ads to Sightline

Sightline includes an optional ad container in the normal sidebar flow, after the utility actions. It stays away from the map, markers, loading state, and analysis buttons. Use that placement first instead of enabling overlay or anchor ads.

## Before applying

Google AdSense requires a site URL without a path. The current GitHub Pages address contains `/sightline-app`, so connect a custom domain such as `sightline.example.com` before applying. Publish useful help, data-source, privacy, and contact information on that domain and make sure the site is publicly reachable.

## Connect AdSense

1. Add the custom domain in **AdSense → Sites**.
2. Copy the exact AdSense account script and replace the Ads placeholder comment inside the `<head>` of `static/index.html`. It will resemble:

   ```html
   <script async
     src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-YOUR_PUBLISHER_ID"
     crossorigin="anonymous"></script>
   ```

3. Request site review in AdSense. Review commonly takes several days and can take two to four weeks.
4. Configure Google's consent management platform or another certified CMP before serving personalized ads where consent is required.

## Add the in-page ad unit

Create a responsive display ad unit in AdSense. In `static/index.html`, replace the contents of `.ad-placeholder` with the exact unit code AdSense provides:

```html
<ins class="adsbygoogle"
  style="display:block;min-height:90px"
  data-ad-client="ca-pub-YOUR_PUBLISHER_ID"
  data-ad-slot="YOUR_AD_SLOT"
  data-ad-format="auto"
  data-full-width-responsive="true"></ins>
<script>
  (adsbygoogle = window.adsbygoogle || []).push({});
</script>
```

Replace the placeholder inside `#contentAd`, then remove its `hidden` attribute. Do not place ads over the map, map controls, loading state, buttons, results, or other elements users may tap.

## Publish `ads.txt`

Copy the line AdSense gives you into a new root file named `ads.txt`. It normally resembles:

```text
google.com, pub-YOUR_PUBLISHER_ID, DIRECT, f08c47fec0942fa0
```

Add a copy step for `ads.txt` in `build_static.py`, rebuild, and confirm it loads at `https://YOUR_DOMAIN/ads.txt`. Use only the publisher ID from your own AdSense account.

## Deploy and check

Run the full tests and static build, deploy, then check AdSense's **Sites** page for both the approval status and the `ads.txt` status. Ads appear only after Google marks the site ready.
