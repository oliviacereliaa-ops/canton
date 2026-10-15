# Fabric Price Checker

Enter a fabric quotation at a fair and see right away whether it's cheap, fair or expensive compared with past quotes. The reference quotes are read live from your Google Sheet, and every check can be saved back to the same sheet.

## Files
| File | Where it goes |
|---|---|
| `index.html`, `engine.js` | GitHub repo, served by GitHub Pages |
| `Code.gs` | Apps Script inside your Google Sheet |

## Setup (about 10 minutes)

### 1. Google Sheet
1. Open the sheet with your quotations.
2. Name the tab with the quote list **`Quotes`**. If you use another name, change `QUOTES_SHEET` in `Code.gs`.
   - Keep the header row as it is. The checker finds it by the **Article Description** column and reads the price, GSM, width, date and other columns by their header names.
   - The exchange rates above the header row (Rp17,800 and Rp2,680) are picked up automatically.
3. Open **Extensions → Apps Script**, replace the code with `Code.gs`, and set `ACCESS_KEY` to a long random text. Save.
4. Click **Deploy → New deployment → Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Copy the **Web app URL**.
5. A **Fair Inquiries** tab is created automatically the first time you save an inquiry.

After you edit `Code.gs` later, use **Deploy → Manage deployments → Edit → New version**. This keeps the same URL.

### 2. GitHub Pages
1. Create a repo, for example `fabric-price-checker`, and upload `index.html` and `engine.js`.
2. Go to **Settings → Pages → Deploy from branch → main / root**.
3. Open `https://<your-user>.github.io/fabric-price-checker/` on your phone. Then use **Share → Add to Home Screen**.

### 3. Unlock
The Web app URL is built into `index.html` (`SHEET_URL`). Open the page and enter the access key. That device stays unlocked for 24 hours, then asks for the key again. Use **Settings → Lock now** to lock it earlier.

The repo contains the URL but no prices. Without the key, the script returns nothing. If you change `ACCESS_KEY`, every device is asked for the new key the next time it loads data.

## How the verdict works
1. **Normalise.** Every quote is converted to IDR per kg: price per m ÷ (GSM × width cm ÷ 100,000).
   - The original currency (RMB, USD or IDR) is converted at the rates set in Settings, so old RMB quotes use today's rate.
   - Quotes without GSM are compared per m², and quotes without width per metre.
2. **Find peers.** Only quotes with the same FG category and construction (woven, knitted or tufted) are considered.
   - Import is compared with Import, and Local with Local. The other group is shown as a reference only.
   - Peers are ranked by similarity of material, finish (solid, print, emboss, coated, hotmelt and so on) and GSM, about ±20%. The closest 8 are used.
3. **Weight by age.** A quote one half-life old (default 6 months) counts half. Undated quotes count about a third. Quotes older than 12 months are tagged *old*.
4. **Verdict.** The new price's weighted percentile among the peers decides it:
   - below the 25th percentile = **Cheap**
   - 25th to 75th = **Fair**
   - above the 75th = **Expensive**
   - above every peer = **Way above market**
5. **Ask for.** The peer median, converted back into the vendor's own currency and unit (e.g. ¥3.86/m). The "good" price is the 25th percentile.
6. **Confidence.** High needs 5 or more close matches. It drops when matches are loose, few, or mostly old.

## Offline at the fair
The last loaded data is cached on the phone, so checks work without signal. Saved inquiries queue up ("not synced") and are sent to the sheet when you're back online. Duplicates are ignored.

## Data tips (improves accuracy)
- Fill in **GSM and width** for the cotton, TC, Tencel and bamboo bedding rows. About 20 rows are missing them, so those rows can only be compared per m².
- Add a **Quote Date** to the about 20 undated rows.
- Row with a Trello link as the vendor: replace it with the vendor name.
