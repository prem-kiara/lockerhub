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
const COMPANY_SHORT = 'Dhanam Finance';
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

function generateReceiptBuffer(payment, tenant, branch, locker) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const contentW = W - 2 * M;

      // ===== HEADER =====
      let y = 62;
      const logoH = 52;

      // Logo — left aligned
      if (HAS_LOGO) {
        try { doc.image(LOGO_PATH, M, y - logoH - 2, { height: logoH }); } catch (e) { /* skip */ }
      }

      // Company name — centered in text area
      const textAreaLeft = M + 64;
      const textAreaRight = W - M;
      const textAreaCenter = (textAreaLeft + textAreaRight) / 2;

      doc.font('Helvetica-Bold').fontSize(14).fillColor(DARK);
      const nameW = doc.widthOfString(COMPANY_FULL);
      tx(doc, COMPANY_FULL, textAreaCenter - nameW / 2, y - 48);

      doc.font('Helvetica').fontSize(6.5).fillColor('#666666');
      const subText = `CIN: ${CIN}  |  GSTIN: ${GST}  |  Ph: ${PHONE}`;
      const subW = doc.widthOfString(subText);
      tx(doc, subText, textAreaCenter - subW / 2, y - 32);

      doc.font('Helvetica').fontSize(5.5).fillColor('#888888');
      const regText = `Regd: ${REGD}`;
      const regW = doc.widthOfString(regText);
      tx(doc, regText, textAreaCenter - regW / 2, y - 22);

      doc.font('Helvetica-Bold').fontSize(10).fillColor(GOLD);
      const sdlText = 'Safe Deposit Lockers';
      const sdlW = doc.widthOfString(sdlText);
      tx(doc, sdlText, textAreaCenter - sdlW / 2, y - 10);

      // Gold line
      doc.save().strokeColor(GOLD).lineWidth(2).moveTo(M, y + 4).lineTo(W - M, y + 4).stroke().restore();
      y += 18;

      // ===== RECEIPT TITLE =====
      doc.save().fillColor(GOLD).rect(M, y, contentW, 28).fill().restore();
      doc.font('Helvetica-Bold').fontSize(16).fillColor('white');
      const titleText = 'PAYMENT RECEIPT';
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
      doc.save().fillColor('#faf6f0').rect(M, y, contentW, 55).fill().restore();
      doc.save().strokeColor(GOLD).lineWidth(1.5).rect(M, y, contentW, 55).stroke().restore();

      doc.font('Helvetica-Bold').fontSize(12).fillColor(DARK);
      tx(doc, 'Amount Received:', M + 15, y + 10);

      doc.font('Helvetica-Bold').fontSize(22).fillColor(GOLD);
      const amountStr = `₹${formatRupees(payment.amount || 0)}`;
      const amountW = doc.widthOfString(amountStr);
      tx(doc, amountStr, W - M - 15 - amountW, y + 6);

      // Amount in words
      doc.font('Helvetica').fontSize(9).fillColor('#666666');
      const wordsStr = `(Rupees ${numberToWords(payment.amount || 0)} only)`;
      tx(doc, wordsStr, M + 15, y + 34);
      y += 65;

      // ===== NOTES =====
      if (payment.notes) {
        y += 5;
        doc.font('Helvetica').fontSize(8.5).fillColor(GREY);
        tx(doc, 'Notes:', M, y);
        doc.font('Helvetica').fontSize(8.5).fillColor(DARK);
        tx(doc, payment.notes, M + 40, y);
        y += 18;
      }

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
      let y2 = cutY + 15;

      // Mini header
      if (HAS_LOGO) {
        try { doc.image(LOGO_PATH, M, y2, { height: 30 }); } catch (e) { /* skip */ }
      }
      doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK);
      tx(doc, COMPANY_FULL, M + 40, y2 + 2);
      doc.font('Helvetica').fontSize(6).fillColor('#888888');
      tx(doc, `GSTIN: ${GST}  |  Ph: ${PHONE}`, M + 40, y2 + 16);
      y2 += 35;

      // Gold line
      doc.save().strokeColor(GOLD).lineWidth(1.5).moveTo(M, y2).lineTo(W - M, y2).stroke().restore();
      y2 += 6;

      // Title
      doc.font('Helvetica-Bold').fontSize(11).fillColor(GOLD);
      tx(doc, 'PAYMENT RECEIPT — CUSTOMER COPY', M, y2);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK);
      const rcpStr = `Receipt No: ${payment.receipt_no || '-'}`;
      const rcpW = doc.widthOfString(rcpStr);
      tx(doc, rcpStr, W - M - rcpW, y2);
      y2 += 20;

      // Compact details in a table-like format
      const lx = M;
      const vx = M + 110;
      const lx2 = W / 2 + 10;
      const vx2 = W / 2 + 110;

      function compactRow(l1, v1, l2, v2) {
        doc.font('Helvetica').fontSize(8).fillColor(GREY); tx(doc, l1, lx, y2);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(DARK); tx(doc, v1 || '-', vx, y2);
        if (l2) {
          doc.font('Helvetica').fontSize(8).fillColor(GREY); tx(doc, l2, lx2, y2);
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor(DARK); tx(doc, v2 || '-', vx2, y2);
        }
        y2 += 15;
      }

      compactRow('Date:', formatDate(payment.paid_on || payment.due_date), 'Branch:', (branch && branch.name) || '-');
      compactRow('Customer:', tenant.name || '-', 'Phone:', tenant.phone || '-');
      compactRow('Locker No:', (locker && locker.number) || tenant.locker_number || '-', 'Type:', capitalize(payment.type || 'rent'));
      compactRow('Period:', payment.period || '-', 'Method:', capitalize(payment.method || '-'));
      if (payment.ref_no) compactRow('Reference:', payment.ref_no, '', '');

      y2 += 5;

      // Amount box
      doc.save().fillColor('#faf6f0').rect(M, y2, contentW, 35).fill().restore();
      doc.save().strokeColor(GOLD).lineWidth(1).rect(M, y2, contentW, 35).stroke().restore();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK);
      tx(doc, 'Amount:', M + 10, y2 + 5);
      doc.font('Helvetica-Bold').fontSize(16).fillColor(GOLD);
      const amt2 = `₹${formatRupees(payment.amount || 0)}`;
      tx(doc, amt2, M + 75, y2 + 3);
      doc.font('Helvetica').fontSize(7.5).fillColor('#666666');
      tx(doc, `(Rupees ${numberToWords(payment.amount || 0)} only)`, M + 10, y2 + 22);
      y2 += 42;

      // Signatures
      y2 += 15;
      doc.save().strokeColor(LGREY).lineWidth(0.5)
        .moveTo(M, y2).lineTo(M + 140, y2).stroke()
        .moveTo(W - M - 140, y2).lineTo(W - M, y2).stroke().restore();
      y2 += 4;
      doc.font('Helvetica').fontSize(7).fillColor(GREY);
      tx(doc, "Customer's Signature", M, y2);
      tx(doc, 'Authorised Signatory', W - M - 140, y2);

      // Bottom footer
      doc.font('Helvetica').fontSize(5).fillColor('#aaaaaa');
      tx(doc, `© ${COMPANY_FULL}. This is a computer-generated receipt.`, M, H - 20);
      tx(doc, 'Thank you for choosing Dhanam Finance Safe Deposit Lockers.', 0, H - 20, { width: W - M, align: 'right' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateReceiptBuffer };
