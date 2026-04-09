/**
 * Dhanam Investment and Finance Private Limited
 * Payment Receipt PDF Generator (PDFKit)
 * Generates a branded, printable receipt for any payment.
 */
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

// Constants
const W = 595.28; // A4 width
const H = 841.89; // A4 height
const M = 40;     // margin
const GOLD = '#b8860b';
const DARK = '#2c1810';
const GREY = '#999999';
const LGREY = '#e3d5c3';
const COMPANY_SHORT = 'Dhanam Investment and Finance';
const COMPANY_FULL = 'Dhanam Investment and Finance Private Limited';
const CIN = 'U65900TZ2016PTC031308';
const GST = '33AAGCK3310G1Z2';
const REGD = 'Door No. 22/3, Nehru Nagar, 2nd St, Behind CMS School, Ganapathy, Coimbatore - 641 006.';
const CORP = '2nd Floor, Dharshini Business Centre, Chinniyampalayam, Coimbatore, Tamil Nadu 641048.';
const PHONE = '1800 202 5180';

const LOGO_PATH = path.join(__dirname, 'public', 'logo.png');
const HAS_LOGO = fs.existsSync(LOGO_PATH);

// Helper: positioned text
function tx(doc, text, x, y, opts) {
  doc.text(String(text || ''), x, y, Object.assign({ lineBreak: false }, opts || {}));
}

// Format date
function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (e) { return dateStr; }
}

// Format currency Indian style
function formatRupees(num) {
  if (!num) return '0';
  return Number(num).toLocaleString('en-IN');
}

// Number to words (Indian style)
function numberToWords(num) {
  if (!num || num === 0) return 'Zero';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const n = Math.floor(num);
  if (n < 20) return ones[n];
  if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
  if (n < 1000) return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' and ' + numberToWords(n % 100) : '');
  if (n < 100000) return numberToWords(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + numberToWords(n % 1000) : '');
  if (n < 10000000) return numberToWords(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + numberToWords(n % 100000) : '');
  return numberToWords(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 ? ' ' + numberToWords(n % 10000000) : '');
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

// True if the payment has a stored waiver/GST breakup (new rows); false for
// legacy rows where we should fall back to the single "Amount Received" line.
function hasBreakup(payment) {
  return payment && Number(payment.base_amount) > 0;
}

// Render the itemised breakup (Base / Waiver / Taxable / CGST / SGST / Total)
// inside a fixed-height box. Returns the box height so the caller can advance y.
function renderBreakupBox(doc, payment, x, y, width, opts) {
  const o = opts || {};
  const GOLD_C = '#b8860b';
  const DARK_C = '#2c1810';
  const GREY_C = '#666666';
  const LABEL_SIZE = o.compact ? 8 : 9;
  const VALUE_SIZE = o.compact ? 8 : 9;
  const ROW_H = o.compact ? 13 : 16;
  const PAD_X = 12;
  const PAD_Y = 10;

  const base = Number(payment.base_amount) || 0;
  const waiver = Number(payment.waiver_amount) || 0;
  const taxable = Number(payment.taxable_amount) || (base - waiver);
  const cgst = Number(payment.cgst_amount) || 0;
  const sgst = Number(payment.sgst_amount) || 0;
  const total = Number(payment.amount) || (taxable + cgst + sgst);

  const lines = [];
  lines.push(['Annual Rent (Base)', formatRupees(base)]);
  if (waiver > 0) lines.push(['Waiver Applied', '- ' + formatRupees(waiver), true]);
  lines.push(['Taxable Value', formatRupees(taxable)]);
  lines.push(['CGST @ 9%', formatRupees(cgst)]);
  lines.push(['SGST @ 9%', formatRupees(sgst)]);

  const boxH = PAD_Y * 2 + lines.length * ROW_H + ROW_H + 4; // + total row
  // Background
  doc.save().fillColor('#faf6f0').rect(x, y, width, boxH).fill().restore();
  doc.save().strokeColor(GOLD_C).lineWidth(1.2).rect(x, y, width, boxH).stroke().restore();

  let cy = y + PAD_Y;
  for (const [label, val, isWaiver] of lines) {
    doc.font('Helvetica').fontSize(LABEL_SIZE).fillColor(isWaiver ? '#27ae60' : GREY_C);
    doc.text(String(label), x + PAD_X, cy, { lineBreak: false });
    const valStr = 'Rs. ' + String(val);
    doc.font(isWaiver ? 'Helvetica-Bold' : 'Helvetica-Bold').fontSize(VALUE_SIZE).fillColor(isWaiver ? '#27ae60' : DARK_C);
    const vw = doc.widthOfString(valStr);
    doc.text(valStr, x + width - PAD_X - vw, cy, { lineBreak: false });
    cy += ROW_H;
  }
  // Divider before total
  doc.save().strokeColor('#e0d4c0').lineWidth(0.5).moveTo(x + PAD_X, cy).lineTo(x + width - PAD_X, cy).stroke().restore();
  cy += 4;
  // Total row
  doc.font('Helvetica-Bold').fontSize(LABEL_SIZE + 1).fillColor(DARK_C);
  doc.text('Total Payable', x + PAD_X, cy, { lineBreak: false });
  const totalStr = 'Rs. ' + formatRupees(total);
  doc.font('Helvetica-Bold').fontSize(VALUE_SIZE + 3).fillColor(GOLD_C);
  const tw = doc.widthOfString(totalStr);
  doc.text(totalStr, x + width - PAD_X - tw, cy - 2, { lineBreak: false });
  return boxH;
}

function renderCustomerCopy(doc, payment, tenant, branch, locker, contentW, startY, renderOpts) {
  const rOpts = renderOpts || {};
  let y2 = startY;
  const isFullPage = startY < 100; // Full-page mode (customer-only download)
  const isEsign = !!rOpts.forEsign;

  // Header
  if (HAS_LOGO) {
    const logoH = isFullPage ? 52 : 30;
    try { doc.image(LOGO_PATH, M, y2, { height: logoH }); } catch (e) { /* skip */ }
  }

  if (isFullPage) {
    // Full header for standalone customer copy
    const pageCenter = W / 2;
    doc.font('Helvetica-Bold').fontSize(14).fillColor(DARK);
    const nameW = doc.widthOfString(COMPANY_FULL);
    tx(doc, COMPANY_FULL, pageCenter - nameW / 2, y2);
    doc.font('Helvetica').fontSize(6.5).fillColor('#666666');
    const subText = `CIN: ${CIN}  |  GSTIN: ${GST}  |  Ph: ${PHONE}`;
    const subW = doc.widthOfString(subText);
    tx(doc, subText, pageCenter - subW / 2, y2 + 16);
    doc.font('Helvetica').fontSize(5.5).fillColor('#888888');
    const regText = `Regd: ${REGD}`;
    const regW = doc.widthOfString(regText);
    tx(doc, regText, pageCenter - regW / 2, y2 + 26);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(GOLD);
    const sdlText = 'Hi-Tech Lockers';
    const sdlW = doc.widthOfString(sdlText);
    tx(doc, sdlText, pageCenter - sdlW / 2, y2 + 38);
    y2 += 55;
  } else {
    // Compact header for bottom-of-page copy
    doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK);
    tx(doc, COMPANY_FULL, M + 40, y2 + 2);
    doc.font('Helvetica').fontSize(6).fillColor('#888888');
    tx(doc, `GSTIN: ${GST}  |  Ph: ${PHONE}`, M + 40, y2 + 16);
    y2 += 35;
  }

  // Gold line
  doc.save().strokeColor(GOLD).lineWidth(1.5).moveTo(M, y2).lineTo(W - M, y2).stroke().restore();
  y2 += 6;

  // Title
  const titleFontSize = isFullPage ? 14 : 11;
  doc.font('Helvetica-Bold').fontSize(titleFontSize).fillColor(GOLD);
  tx(doc, 'PAYMENT RECEIPT — CUSTOMER COPY', M, y2);
  doc.font('Helvetica-Bold').fontSize(isFullPage ? 10 : 9).fillColor(DARK);
  const rcpStr = `Receipt No: ${payment.receipt_no || '-'}`;
  const rcpW = doc.widthOfString(rcpStr);
  tx(doc, rcpStr, W - M - rcpW, y2);
  y2 += isFullPage ? 28 : 20;

  // Details
  const lx = M;
  const vx = M + 110;
  const lx2 = W / 2 + 10;
  const vx2 = W / 2 + 110;
  const rowH = isFullPage ? 20 : 15;
  const labelSize = isFullPage ? 9 : 8;
  const valSize = isFullPage ? 10 : 8.5;

  function compactRow(l1, v1, l2, v2) {
    doc.font('Helvetica').fontSize(labelSize).fillColor(GREY); tx(doc, l1, lx, y2);
    doc.font('Helvetica-Bold').fontSize(valSize).fillColor(DARK); tx(doc, v1 || '-', vx, y2);
    if (l2) {
      doc.font('Helvetica').fontSize(labelSize).fillColor(GREY); tx(doc, l2, lx2, y2);
      doc.font('Helvetica-Bold').fontSize(valSize).fillColor(DARK); tx(doc, v2 || '-', vx2, y2);
    }
    y2 += rowH;
  }

  compactRow('Date:', formatDate(payment.paid_on || payment.due_date), 'Branch:', (branch && branch.name) || '-');
  compactRow('Customer:', tenant.name || '-', 'Phone:', tenant.phone || '-');
  compactRow('Locker No:', (locker && locker.number) || tenant.locker_number || '-', 'Type:', capitalize(payment.type || 'rent'));
  compactRow('Period:', payment.period || '-', 'Method:', capitalize(payment.method || '-'));
  if (payment.ref_no) compactRow('Reference:', payment.ref_no, '', '');

  y2 += isFullPage ? 15 : 5;

  // Amount box — new breakup mode (waiver + CGST/SGST) when present,
  // otherwise fall back to the legacy single-line "Amount Received" display.
  if (hasBreakup(payment) && (payment.type === 'rent' || !payment.type)) {
    const breakH = renderBreakupBox(doc, payment, M, y2, contentW, { compact: !isFullPage });
    // Amount in words just below the box
    doc.font('Helvetica').fontSize(isFullPage ? 8.5 : 7).fillColor('#666666');
    tx(doc, `(Rupees ${numberToWords(payment.amount || 0)} only, inclusive of CGST 9% + SGST 9%)`, M + 12, y2 + breakH + 3);
    y2 += breakH + (isFullPage ? 18 : 12);
  } else {
    const boxH = isFullPage ? 55 : 35;
    doc.save().fillColor('#faf6f0').rect(M, y2, contentW, boxH).fill().restore();
    doc.save().strokeColor(GOLD).lineWidth(isFullPage ? 1.5 : 1).rect(M, y2, contentW, boxH).stroke().restore();

    if (isFullPage) {
      doc.font('Helvetica-Bold').fontSize(12).fillColor(DARK);
      tx(doc, 'Amount Received:', M + 15, y2 + 10);
      doc.font('Helvetica-Bold').fontSize(22).fillColor(GOLD);
      const amountStr = `Rs.${formatRupees(payment.amount || 0)}`;
      const amountW = doc.widthOfString(amountStr);
      tx(doc, amountStr, W - M - 15 - amountW, y2 + 6);
      doc.font('Helvetica').fontSize(9).fillColor('#666666');
      tx(doc, `(Rupees ${numberToWords(payment.amount || 0)} only)`, M + 15, y2 + 34);
    } else {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK);
      tx(doc, 'Amount:', M + 10, y2 + 5);
      doc.font('Helvetica-Bold').fontSize(16).fillColor(GOLD);
      const amt2 = `Rs.${formatRupees(payment.amount || 0)}`;
      tx(doc, amt2, M + 75, y2 + 3);
      doc.font('Helvetica').fontSize(7.5).fillColor('#666666');
      tx(doc, `(Rupees ${numberToWords(payment.amount || 0)} only)`, M + 10, y2 + 22);
    }
    y2 += boxH + (isFullPage ? 10 : 7);
  }

  // Notes (full page only)
  if (isFullPage && payment.notes) {
    y2 += 5;
    doc.font('Helvetica').fontSize(8.5).fillColor(GREY);
    tx(doc, 'Notes:', M, y2);
    doc.font('Helvetica').fontSize(8.5).fillColor(DARK);
    tx(doc, payment.notes, M + 40, y2);
    y2 += 18;
  }

  // Signatures — only show manual sig lines if NOT an e-sign copy
  if (!isEsign) {
    y2 += isFullPage ? 30 : 15;
    const sigW = isFullPage ? 160 : 140;
    doc.save().strokeColor(LGREY).lineWidth(0.5)
      .moveTo(M, y2).lineTo(M + sigW, y2).stroke()
      .moveTo(W - M - sigW, y2).lineTo(W - M, y2).stroke().restore();
    y2 += isFullPage ? 5 : 4;
    doc.font('Helvetica').fontSize(isFullPage ? 8 : 7).fillColor(GREY);
    tx(doc, "Customer's Signature", M, y2);
    tx(doc, 'Authorised Signatory', W - M - sigW, y2);

    if (isFullPage) {
      y2 += 12;
      doc.font('Helvetica-Bold').fontSize(7).fillColor(DARK);
      tx(doc, `For ${COMPANY_FULL}`, W - M - sigW, y2);
    }
  }

  // Bottom-right e-sign placeholder box (matches Digio sign_coordinates: llx:355, lly:40 in PDF coords)
  // In PDFKit coords (top-left origin): x=355, y = 841.89 - 130 = ~712
  if (isEsign) {
    const bx = 355, by = 712, bw = 200, bh = 90;
    doc.save().strokeColor(LGREY).lineWidth(0.5).rect(bx, by, bw, bh).stroke().restore();
    doc.font('Helvetica-Bold').fontSize(7).fillColor(GOLD);
    tx(doc, 'Hirer Signature', bx + 5, by + 5);
    doc.font('Helvetica').fontSize(6).fillColor(GREY);
    tx(doc, '(E-Sign)', bx + 5, by + 16);
    doc.fillColor('black');
  }

  // Bottom footer
  doc.font('Helvetica').fontSize(5).fillColor('#aaaaaa');
  tx(doc, `© ${COMPANY_FULL}. This is a computer-generated receipt.`, M, H - 20);
  tx(doc, 'Thank you for choosing Dhanam Hi-Tech Lockers.', 0, H - 20, { width: W - M, align: 'right' });
}

function generateReceiptBuffer(payment, tenant, branch, locker, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const contentW = W - 2 * M;

      // Helper: draw bottom-right e-sign placeholder matching Digio coords (llx:355, lly:40, urx:555, ury:130)
      // PDFKit coords (top-left origin): x=355, y=841.89-130 = ~712
      function drawEsignBox(doc) {
        const bx = 355, by = 712, bw = 200, bh = 90;
        doc.save().strokeColor(LGREY).lineWidth(0.5).rect(bx, by, bw, bh).stroke().restore();
        doc.font('Helvetica-Bold').fontSize(7).fillColor(GOLD);
        tx(doc, 'Hirer Signature', bx + 5, by + 5);
        doc.font('Helvetica').fontSize(6).fillColor(GREY);
        tx(doc, '(E-Sign)', bx + 5, by + 16);
        doc.fillColor('black');
      }

      // If customer copy only, skip the company copy and render customer copy full-page
      if (opts.customerOnly) {
        renderCustomerCopy(doc, payment, tenant, branch, locker, contentW, 50);
        doc.end();
        return;
      }

      // For e-sign: render full-page company copy on page 1, full-page customer copy on page 2, both with sign boxes
      const isEsign = !!opts.forEsign;

      // ===== PAGE 1: COMPANY COPY =====
      // ===== HEADER =====
      let y = 62;
      const logoH = 52;

      // Logo — left aligned
      if (HAS_LOGO) {
        try { doc.image(LOGO_PATH, M, y - logoH - 2, { height: logoH }); } catch (e) { /* skip */ }
      }

      // Company name — centered on full page width
      const pageCenter = W / 2;

      doc.font('Helvetica-Bold').fontSize(14).fillColor(DARK);
      const nameW = doc.widthOfString(COMPANY_FULL);
      tx(doc, COMPANY_FULL, pageCenter - nameW / 2, y - 48);

      doc.font('Helvetica').fontSize(6.5).fillColor('#666666');
      const subText = `CIN: ${CIN}  |  GSTIN: ${GST}  |  Ph: ${PHONE}`;
      const subW = doc.widthOfString(subText);
      tx(doc, subText, pageCenter - subW / 2, y - 32);

      doc.font('Helvetica').fontSize(5.5).fillColor('#888888');
      const regText = `Regd: ${REGD}`;
      const regW = doc.widthOfString(regText);
      tx(doc, regText, pageCenter - regW / 2, y - 22);

      doc.font('Helvetica-Bold').fontSize(10).fillColor(GOLD);
      const sdlText = 'Hi-Tech Lockers';
      const sdlW = doc.widthOfString(sdlText);
      tx(doc, sdlText, pageCenter - sdlW / 2, y - 10);

      // Gold line
      doc.save().strokeColor(GOLD).lineWidth(2).moveTo(M, y + 4).lineTo(W - M, y + 4).stroke().restore();
      y += 18;

      // ===== RECEIPT TITLE =====
      doc.save().fillColor(GOLD).rect(M, y, contentW, 28).fill().restore();
      doc.font('Helvetica-Bold').fontSize(16).fillColor('white');
      const titleText = isEsign ? 'PAYMENT RECEIPT — COMPANY COPY' : 'PAYMENT RECEIPT';
      const titleW = doc.widthOfString(titleText);
      tx(doc, titleText, (W - titleW) / 2, y + 6);
      doc.fillColor('black');
      y += 38;

      // ===== RECEIPT META (Receipt No + Date) =====
      doc.save().fillColor('#faf6f0').rect(M, y, contentW, 30).fill().restore();
      doc.save().strokeColor(LGREY).lineWidth(0.5).rect(M, y, contentW, 30).stroke().restore();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK);
      tx(doc, `Receipt No: ${payment.receipt_no || '-'}`, M + 12, y + 9);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK);
      const dateText = `Date: ${formatDate(payment.paid_on || payment.due_date || payment.created_at)}`;
      const dateW = doc.widthOfString(dateText);
      tx(doc, dateText, W - M - 12 - dateW, y + 9);
      y += 40;

      // ===== BRANCH INFO =====
      doc.font('Helvetica').fontSize(9).fillColor('#666666');
      tx(doc, `Branch: ${(branch && branch.name) || '-'}${branch && branch.location ? ', ' + branch.location : ''}`, M, y);
      y += 20;

      // ===== TENANT / CUSTOMER INFO =====
      doc.save().fillColor(GOLD).rect(M, y, contentW, 18).fill().restore();
      doc.font('Helvetica-Bold').fontSize(9).fillColor('white');
      tx(doc, 'CUSTOMER DETAILS', M + 8, y + 4);
      doc.fillColor('black');
      y += 22;

      const col1 = M + 8;
      const col2 = M + 130;
      const col3 = W / 2 + 20;
      const col4 = W / 2 + 130;

      function row(label1, val1, label2, val2) {
        doc.font('Helvetica').fontSize(8.5).fillColor(GREY);
        tx(doc, label1, col1, y);
        doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK);
        tx(doc, val1 || '-', col2, y);
        if (label2) {
          doc.font('Helvetica').fontSize(8.5).fillColor(GREY);
          tx(doc, label2, col3, y);
          doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK);
          tx(doc, val2 || '-', col4, y);
        }
        y += 18;
      }

      row('Customer Name:', tenant.name || '-', 'Phone:', tenant.phone || '-');
      row('Locker No:', (locker && locker.number) || tenant.locker_number || '-', 'Locker Type:', (locker && locker.size) || '-');

      // Divider
      doc.save().strokeColor(LGREY).lineWidth(0.5).moveTo(M, y + 2).lineTo(W - M, y + 2).stroke().restore();
      y += 12;

      // ===== PAYMENT DETAILS =====
      doc.save().fillColor(GOLD).rect(M, y, contentW, 18).fill().restore();
      doc.font('Helvetica-Bold').fontSize(9).fillColor('white');
      tx(doc, 'PAYMENT DETAILS', M + 8, y + 4);
      doc.fillColor('black');
      y += 22;

      const paymentType = capitalize(payment.type || 'rent');
      const paymentMethod = capitalize(payment.method || '-');
      const paymentStatus = payment.status || '-';

      row('Payment Type:', paymentType, 'Period:', payment.period || '-');
      row('Payment Method:', paymentMethod, 'Reference No:', payment.ref_no || '-');
      row('Payment Date:', formatDate(payment.paid_on || payment.due_date), 'Status:', paymentStatus);

      // Divider
      doc.save().strokeColor(LGREY).lineWidth(0.5).moveTo(M, y + 2).lineTo(W - M, y + 2).stroke().restore();
      y += 16;

      // ===== AMOUNT BOX =====
      if (hasBreakup(payment) && (payment.type === 'rent' || !payment.type)) {
        const breakH = renderBreakupBox(doc, payment, M, y, contentW, { compact: false });
        doc.font('Helvetica').fontSize(9).fillColor('#666666');
        tx(doc, `(Rupees ${numberToWords(payment.amount || 0)} only, inclusive of CGST 9% + SGST 9%)`, M + 15, y + breakH + 4);
        y += breakH + 18;
      } else {
        doc.save().fillColor('#faf6f0').rect(M, y, contentW, 55).fill().restore();
        doc.save().strokeColor(GOLD).lineWidth(1.5).rect(M, y, contentW, 55).stroke().restore();

        doc.font('Helvetica-Bold').fontSize(12).fillColor(DARK);
        tx(doc, 'Amount Received:', M + 15, y + 10);

        doc.font('Helvetica-Bold').fontSize(22).fillColor(GOLD);
        const amountStr = `Rs.${formatRupees(payment.amount || 0)}`;
        const amountW = doc.widthOfString(amountStr);
        tx(doc, amountStr, W - M - 15 - amountW, y + 6);

        // Amount in words
        doc.font('Helvetica').fontSize(9).fillColor('#666666');
        const wordsStr = `(Rupees ${numberToWords(payment.amount || 0)} only)`;
        tx(doc, wordsStr, M + 15, y + 34);
        y += 65;
      }

      // ===== NOTES =====
      if (payment.notes) {
        y += 5;
        doc.font('Helvetica').fontSize(8.5).fillColor(GREY);
        tx(doc, 'Notes:', M, y);
        doc.font('Helvetica').fontSize(8.5).fillColor(DARK);
        tx(doc, payment.notes, M + 40, y);
        y += 18;
      }

      if (isEsign) {
        // E-Sign mode: sign box at bottom-right of page 1, then full customer copy on page 2
        drawEsignBox(doc);

        // Page 1 footer
        doc.font('Helvetica').fontSize(5).fillColor('#aaaaaa');
        tx(doc, `© ${COMPANY_FULL}. This is a computer-generated receipt.`, M, H - 20);

        // ===== PAGE 2: CUSTOMER COPY (full-page with sign box) =====
        doc.addPage({ size: 'A4', margin: 0 });
        renderCustomerCopy(doc, payment, tenant, branch, locker, contentW, 50, { forEsign: true });
      } else {
        // Normal print mode: company copy + cut line + compact customer copy on same page
        y += 25;

        // ===== SIGNATURES =====
        const sigLineW = 160;
        doc.save().strokeColor(LGREY).lineWidth(0.5)
          .moveTo(M, y).lineTo(M + sigLineW, y).stroke()
          .moveTo(W - M - sigLineW, y).lineTo(W - M, y).stroke().restore();
        y += 5;
        doc.font('Helvetica').fontSize(8).fillColor(GREY);
        tx(doc, "Customer's Signature", M, y);
        tx(doc, 'Authorised Signatory', W - M - sigLineW, y);
        y += 12;
        doc.font('Helvetica-Bold').fontSize(7).fillColor(DARK);
        tx(doc, `For ${COMPANY_FULL}`, W - M - sigLineW, y);

        // ===== FOOTER =====
        // Dashed cut line — positioned dynamically below company copy content
        const cutY = Math.max(y + 25, H / 2 + 10);
        doc.save().strokeColor('#cccccc').lineWidth(0.5).dash(5, { space: 3 })
          .moveTo(M, cutY).lineTo(W - M, cutY).stroke().undash().restore();
        doc.font('Helvetica').fontSize(6).fillColor('#aaaaaa');
        const cutText = '✂ Customer Copy (Below) — Company Copy (Above)';
        const cutW = doc.widthOfString(cutText);
        tx(doc, cutText, (W - cutW) / 2, cutY - 8);

        // ===== DUPLICATE COPY (customer copy — compact) =====
        renderCustomerCopy(doc, payment, tenant, branch, locker, contentW, cutY + 15);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateReceiptBuffer };
