/**
 * LeveLux Seller Scan — printable tag endpoint (Vercel serverless).
 *
 * Generates the exact same 50mm x 30mm printable tag used by the Photo Intake app for new
 * intake (wrapped title, Code39 barcode of the SKU, the SKU as text, standard LeveLux footer)
 * so a seller can reprint a lost/damaged tag for an item already live in the catalog, straight
 * from its Seller Scan item view.
 *
 * Returns a standard PDF (Content-Type: application/pdf), so printing it is entirely a matter
 * of the browser's own print dialog once it opens — a Rollo label printer (installed as a
 * normal system printer via its own driver) and any AirPrint-enabled printer both just show up
 * there like any other printer. No server-side branching for one vs. the other is needed; the
 * one thing to get right on the print dialog itself is "Actual size" (not "Fit to page"), since
 * the PDF page is fixed at exactly 50mm x 30mm to match the physical label stock.
 *
 * Shares the SCAN_PASSCODE env var already set up for the other endpoints -- no new environment
 * variables needed to deploy this alongside them.
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const bwipjs = require('bwip-js');
const passcodeMatches = require('./_passcode.js');

const MM = 2.834645669291339; // points per millimeter
const WIDTH = 50 * MM;
const HEIGHT = 30 * MM;

function wrapTitle(font, title, maxWidth, startSize = 8.0, minSize = 5.5) {
  let display = title || '';
  if (display.startsWith('Authentic ')) {
    display = display.slice('Authentic '.length);
  }
  let size = startSize;
  while (size >= minSize) {
    const words = display.split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const trial = (cur + ' ' + w).trim();
      if (font.widthOfTextAtSize(trial, size) <= maxWidth) {
        cur = trial;
      } else {
        if (cur) lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    if (
      lines.length <= 2 &&
      lines.every((l) => font.widthOfTextAtSize(l, size) <= maxWidth)
    ) {
      return { lines, size };
    }
    size -= 0.25;
  }
  // Fallback: truncate at min size, at most 2 lines.
  const words = display.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const trial = (cur + ' ' + w).trim();
    if (font.widthOfTextAtSize(trial, minSize) <= maxWidth) {
      cur = trial;
    } else {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length === 2) break;
    }
  }
  if (cur && lines.length < 2) lines.push(cur);
  return { lines: lines.slice(0, 2), size: minSize };
}

// Decode PNG width/height straight from the header bytes (avoids pulling in an image-metadata
// dependency just for this).
function pngDimensions(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function drawTag(pdfDoc, font, sku, title) {
  const page = pdfDoc.addPage([WIDTH, HEIGHT]);
  const margin = 2 * MM;
  const maxW = WIDTH - 2 * margin;

  const footer2Y = 1.6 * MM;
  const footer1Y = 3.3 * MM;
  const skuY = 5.6 * MM;
  const barcodeY = 7.7 * MM;
  const barcodeH = 8.2 * MM;
  const titleGap = 1.1 * MM;

  const { lines, size } = wrapTitle(font, title, maxW, 8.0, 5.5);
  const lineH = size + 1.3;
  const titleBottomY = barcodeY + barcodeH + titleGap;

  lines
    .slice()
    .reverse()
    .forEach((line, i) => {
      const y = titleBottomY + i * lineH;
      const w = font.widthOfTextAtSize(line, size);
      page.drawText(line, {
        x: WIDTH / 2 - w / 2,
        y,
        size,
        font,
        color: rgb(0, 0, 0),
      });
    });

  // Barcode (Code 39), rendered via bwip-js and embedded as a PNG, then drawn at the exact
  // physical size the original Photo Intake tag used.
  const png = await bwipjs.toBuffer({
    bcid: 'code39',
    text: sku,
    scale: 4,
    height: 10,
    includetext: false,
    backgroundcolor: 'FFFFFF',
  });
  const { width: pxW, height: pxH } = pngDimensions(png);
  const img = await pdfDoc.embedPng(png);
  let drawW = barcodeH * (pxW / pxH);
  let drawH = barcodeH;
  if (drawW > maxW) {
    const scale = maxW / drawW;
    drawW *= scale;
    drawH *= scale;
  }
  page.drawImage(img, {
    x: WIDTH / 2 - drawW / 2,
    y: barcodeY,
    width: drawW,
    height: drawH,
  });

  // SKU text
  const skuSize = 6;
  const skuW = font.widthOfTextAtSize(sku, skuSize);
  page.drawText(sku, {
    x: WIDTH / 2 - skuW / 2,
    y: skuY,
    size: skuSize,
    font,
    color: rgb(0, 0, 0),
  });

  // Footer
  const f1 = 'Follow LeveLuxbag Instagram';
  const f1Size = 4.0;
  const f1W = font.widthOfTextAtSize(f1, f1Size);
  page.drawText(f1, {
    x: WIDTH / 2 - f1W / 2,
    y: footer1Y,
    size: f1Size,
    font,
    color: rgb(0, 0, 0),
  });

  const f2 = 'Consignment: www.LeveLuxbag.com';
  const f2Size = 4.0;
  const f2W = font.widthOfTextAtSize(f2, f2Size);
  page.drawText(f2, {
    x: WIDTH / 2 - f2W / 2,
    y: footer2Y,
    size: f2Size,
    font,
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.STOREFRONT_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  const body = req.body || {};

  if (!passcodeMatches(body.passcode)) {
    res.status(401).json({ error: 'Not authorized' });
    return;
  }

  const sku = body.sku;
  const title = body.title || sku;

  if (!sku) {
    res.status(400).json({ error: 'Missing sku' });
    return;
  }

  try {
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    await drawTag(pdfDoc, font, sku, title);
    const bytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${sku}-tag.pdf"`);
    res.status(200).send(Buffer.from(bytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Tag generation failed' });
  }
};
