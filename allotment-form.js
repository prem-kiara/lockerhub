/**
 * Dhanam Investment and Finance Private Limited
 * Hi-Tech Locker Allotment Form (PDFKit)
 * Generates a multi-page allotment form with tenant data pre-filled.
 */
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

// Constants
const W = 595.28; // A4 width
const H = 841.89; // A4 height
const M = 40; // margin
const GOLD = '#b8860b';
const DARK = '#2c1810';
const RED = '#c0392b';
const GREY = '#999999';
const LGREY = '#cccccc';
const COMPANY_SHORT = 'Dhanam Finance';
const COMPANY_FULL = 'Dhanam Investment and Finance Private Limited';
const CIN = 'U65900TZ2016PTC031308';
const GST = '33AAGCK3310G1Z2';
const REGD = 'Door No. 22/3, Nehru Nagar, 2nd St, Behind CMS School, Ganapathy, Coimbatore - 641 006.';
const CORP = '2nd Floor, Dharshini Business Centre, Chinniyampalayam, Coimbatore, Tamil Nadu 641048.';
const PHONE = '1800 202 5180';

// Logo path
const LOGO_PATH = path.join(__dirname, 'public', 'logo.png');
const HAS_LOGO = fs.existsSync(LOGO_PATH);

// Helper: format date to DD/MM/YYYY
function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch (e) { return dateStr; }
}

// Helper: format currency
function formatRupees(num) {
  if (!num) return '0';
  return Number(num).toLocaleString('en-IN');
}

// Helper: number to words (Indian style)
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

// Helper: positioned text with NO line break (prevents auto-pagination)
function tx(doc, text, x, y, opts) {
  doc.text(String(text || ''), x, y, Object.assign({ lineBreak: false }, opts || {}));
}

function drawHeader(doc, y) {
  if (!y) y = 62;
  const logoH = 52;
  const logoW = HAS_LOGO ? 56 : 0;

  // Logo — left aligned at margin
  if (HAS_LOGO) {
    try { doc.image(LOGO_PATH, M, y - logoH - 2, { height: logoH }); } catch (e) { /* skip */ }
  }

  // Company name — centered on full page width
  const pageCenter = W / 2;

  doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK);
  const nameW = doc.widthOfString(COMPANY_FULL);
  tx(doc, COMPANY_FULL, pageCenter - nameW / 2, y - 48);

  // CIN / GST / Phone — centered in text area
  doc.font('Helvetica').fontSize(6.5).fillColor('#666666');
  const subText = `CIN: ${CIN}  |  GST: ${GST}  |  Ph: ${PHONE}`;
  const subW = doc.widthOfString(subText);
  tx(doc, subText, pageCenter - subW / 2, y - 32);

  // Registered office — centered in text area
  doc.font('Helvetica').fontSize(5.5).fillColor('#888888');
  const regText = `Regd: ${REGD}`;
  const regW = doc.widthOfString(regText);
  tx(doc, regText, pageCenter - regW / 2, y - 22);

  // "Hi-Tech Lockers" — centered on full page width
  doc.font('Helvetica-Bold').fontSize(10).fillColor(GOLD);
  const sdlText = 'Hi-Tech Lockers';
  const sdlW = doc.widthOfString(sdlText);
  tx(doc, sdlText, pageCenter - sdlW / 2, y - 10);

  // Gold accent line
  doc.save().strokeColor(GOLD).lineWidth(2).moveTo(M, y + 4).lineTo(W - M, y + 4).stroke().restore();
  doc.fillColor('black');
  return y + 16;
}

function drawFooter(doc, version) {
  doc.font('Helvetica').fontSize(5.5).fillColor('#888888');
  tx(doc, `\u00A9 ${COMPANY_FULL}. Private and confidential. Unauthorized reproduction is strictly prohibited.`, M, H - 22);
  tx(doc, version || 'DFIN/ALT/01/Ver 1.0', 0, H - 22, { width: W - M, align: 'right' });
  doc.fillColor('black');
}

function sectionTitle(doc, title, y, color) {
  doc.save().fillColor(color || GOLD).rect(M, y, W - 2 * M, 16).fill().restore();
  doc.font('Helvetica-Bold').fontSize(10).fillColor('white');
  tx(doc, title, M + 6, y + 3);
  doc.fillColor('black');
  return y + 19;
}

function field(doc, label, x, y, val, fw, lw) {
  fw = fw || 180;
  lw = lw || doc.font('Helvetica').fontSize(8).widthOfString(label) + 8;
  doc.font('Helvetica').fontSize(8).fillColor('black');
  tx(doc, label, x, y);
  const fx = x + lw;
  doc.save().strokeColor(LGREY).lineWidth(0.5).moveTo(fx, y + 11).lineTo(fx + fw, y + 11).stroke().restore();
  if (val) {
    doc.font('Helvetica').fontSize(8).fillColor(DARK);
    tx(doc, val, fx + 2, y);
  }
  doc.fillColor('black');
  return y + 16;
}

function checkbox(doc, label, x, y, checked) {
  doc.save().strokeColor(GOLD).lineWidth(0.8).rect(x, y, 9, 9).stroke().restore();
  if (checked) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor('black');
    tx(doc, 'X', x + 2, y + 1);
  }
  doc.font('Helvetica').fontSize(7).fillColor('black');
  tx(doc, label, x + 12, y + 1);
  return x + 12 + doc.widthOfString(label) + 10;
}

function labeledBox(doc, label, x, y, w, h) {
  doc.save().strokeColor(LGREY).lineWidth(0.5).rect(x, y, w, h).stroke().restore();
  doc.font('Helvetica').fontSize(6).fillColor(GREY);
  tx(doc, label, x + 3, y + h / 2 - 3);
  doc.fillColor('black');
}

function newPage(doc) {
  doc.addPage({ size: 'A4', margin: 0 });
}

// ================================================================
// PAGE 1: SPECIMEN SIGNATURE CARD
// ================================================================
function page1(doc, t, branch) {
  let y = drawHeader(doc);
  y += 8;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(GOLD);
  const p1Title = 'SPECIMEN SIGNATURE CARD';
  tx(doc, p1Title, (W - doc.widthOfString(p1Title)) / 2, y);
  doc.fillColor('black');
  y += 25;

  y = field(doc, 'Branch Name:', M, y, branch.name || '', 150, 80);
  field(doc, 'Agreement No.:', W / 2 + 20, y - 16, t.agreement_no || 'Auto-generated', 140, 90);
  y += 3;

  y = sectionTitle(doc, 'Hirer Details', y);
  y += 3;
  y = field(doc, 'Full Name:', M, y, t.name || '', W - 2 * M - 100, 70);
  y += 3;

  labeledBox(doc, 'Paste Passport Size Photo', W - M - 95, y, 95, 110);

  doc.font('Helvetica').fontSize(8).fillColor('black');
  tx(doc, 'Specimen Signature:', M, y);
  y += 12;
  labeledBox(doc, 'Sign Here', M, y, 190, 65);
  y += 78;

  y = field(doc, 'Verified by:', M, y, '', 180, 70);
  y = field(doc, 'Date:', M, y, '', 120, 35);

  y += 10;
  y = sectionTitle(doc, 'Authorized Person / Nominee (if applicable)', y);
  y += 3;
  y = field(doc, 'Name:', M, y, '', 200, 45);
  y += 3;

  labeledBox(doc, 'Photo', W - M - 95, y, 95, 110);

  doc.font('Helvetica').fontSize(8);
  tx(doc, 'Specimen Signature:', M, y);
  y += 12;
  labeledBox(doc, 'Sign Here', M, y, 190, 65);
  y += 78;

  y = field(doc, 'Verified by:', M, y, '', 180, 70);
  y = field(doc, 'Date:', M, y, '', 120, 35);

  drawFooter(doc, 'DFIN/ALT/01/Ver 1.0');
}

// ================================================================
// PAGE 2: CUSTOMER FEEDBACK FORM
// ================================================================
function page2(doc, t, branch) {
  newPage(doc);
  let y = drawHeader(doc);
  y += 8;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK);
  const p2Title = 'CUSTOMER FEEDBACK FORM - ALLOTMENT';
  tx(doc, p2Title, (W - doc.widthOfString(p2Title)) / 2, y);
  doc.fillColor('black');
  y += 25;

  y = field(doc, 'Branch Name:', M, y, branch.name || '', 120, 90);
  field(doc, 'Agreement No:', W / 2 + 10, y - 16, t.agreement_no || '', 120, 90);
  y = field(doc, 'Customer Name:', M, y, t.name || '', 120, 100);
  field(doc, 'Allotment Date:', W / 2 + 10, y - 16, formatDate(t.allotment_date), 120, 95);
  y += 6;

  const descriptions = [
    'I am satisfied with the time taken from enquiry to allotment',
    'The Locker allotment procedures were explained to me clearly',
    'The locker type suits my requirement',
    'The Locker allotment procedure is simple',
    'The safety aspects in the branch is adequate',
    'The branch ambience is pleasant',
    'The branch staff are customer oriented',
  ];

  doc.save().fillColor(GOLD).rect(M, y, W - 2 * M, 20).fill().restore();
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor('white');
  tx(doc, 'Description', M + 5, y + 7);
  const cols = [M + 255, M + 310, M + 355, M + 400, M + 450];
  const hd = ['Strongly Agree(5)', 'Agree(4)', 'Neither(3)', 'Disagree(2)', 'Strongly Disagree(1)'];
  hd.forEach((h, i) => tx(doc, h, cols[i] - 8, y + 7));
  doc.fillColor('black');
  y += 22;

  descriptions.forEach(desc => {
    doc.font('Helvetica').fontSize(7.5).fillColor('black');
    tx(doc, desc, M + 5, y + 3);
    doc.save().strokeColor('#dddddd').lineWidth(0.5).moveTo(M, y + 14).lineTo(W - M, y + 14).stroke().restore();
    cols.forEach(cx => {
      doc.save().strokeColor(GOLD).lineWidth(0.8).rect(cx, y + 1, 9, 9).stroke().restore();
    });
    y += 16;
  });

  y += 6;
  doc.font('Helvetica').fontSize(7.5);
  tx(doc, `Why I chose ${COMPANY_SHORT} Lockers (Please write):`, M + 5, y);
  y += 12;
  doc.save().strokeColor(LGREY).lineWidth(0.5).rect(M, y, W - 2 * M, 30).stroke().restore();
  y += 38;

  doc.font('Helvetica-Bold').fontSize(7.5);
  tx(doc, `On a scale of 0-10, how likely are you to recommend ${COMPANY_SHORT} Safe Lockers`, M, y);
  y += 10;
  tx(doc, 'to a friend or colleague? (0=least likely, 10=most likely)', M, y);
  y += 15;
  const bw = (W - 2 * M) / 11;
  for (let i = 0; i <= 10; i++) {
    const bx = M + i * bw;
    doc.save().strokeColor(GOLD).lineWidth(0.8).rect(bx, y, bw, 18).stroke().restore();
    doc.font('Helvetica-Bold').fontSize(8).fillColor('black');
    tx(doc, String(i), bx + bw / 2 - 3, y + 5);
  }
  y += 28;

  doc.font('Helvetica').fontSize(8).fillColor('black');
  tx(doc, 'Date: ___________________', M, y);
  tx(doc, 'Customer Signature: ___________________', W / 2 + 40, y);
  y += 25;

  y = sectionTitle(doc, 'For Office Use Only', y, '#666666');
  y += 3;
  y = field(doc, 'Total:', M, y, '', 80, 50);
  doc.font('Helvetica').fontSize(8);
  tx(doc, '/ 35', M + 140, y - 14);
  y = field(doc, 'Customer Satisfaction %:', M, y, '', 80, 150);
  y += 6;
  doc.font('Helvetica').fontSize(6.5).fillColor('#666666');
  tx(doc, "Note: '5' indicates highest level of satisfaction and '1' indicates lowest level of satisfaction.", M, y);
  y += 8;
  tx(doc, 'Calculate no. of count, multiply with the score and measure the satisfaction %.', M, y);
  doc.fillColor('black');
  y += 20;
  tx(doc, 'Branch Manager: ___________________', M, y);
  tx(doc, 'Date: ___________________', W / 2 + 80, y);

  drawFooter(doc, 'DFIN/ALT/02/Ver 1.0');
}

// ================================================================
// PAGE 3: HIRING AGREEMENT
// ================================================================
function page3(doc, t, branch) {
  newPage(doc);
  let y = drawHeader(doc);
  y += 3;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(DARK);
  const p3Title = 'SAFE DEPOSIT LOCKER HIRING AGREEMENT';
  tx(doc, p3Title, (W - doc.widthOfString(p3Title)) / 2, y);
  doc.fillColor('black');
  y += 22;

  labeledBox(doc, 'Revenue Stamp', W - M - 65, y, 60, 55);
  labeledBox(doc, 'Revenue Stamp', W - M - 135, y, 60, 55);

  y = field(doc, 'Branch:', M, y, (branch.name || '') + (branch.location ? ', ' + branch.location : ''), 200, 50);
  y = field(doc, 'Agreement No.:', M, y, t.agreement_no || '', 200, 95);
  y += 3;

  // Auto-fill date parts from lease_start
  const leaseStart = t.allotment_date ? new Date(t.allotment_date) : null;
  const dayStr = leaseStart ? String(leaseStart.getDate()) : '...............';
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthStr = leaseStart ? monthNames[leaseStart.getMonth()] : '..........................';
  const yearStr = leaseStart ? String(leaseStart.getFullYear()).slice(2) : '.........';
  const rentStr = t.rent_amount ? `Rs. ${formatRupees(t.rent_amount)}` : 'Rs. ..........................';
  const rentWordsStr = t.rent_amount ? `(Rupees ${numberToWords(t.rent_amount)} only)` : '(Rupees ........................................ only)';
  const branchAddr = branch.location || branch.address || '..............................';

  doc.font('Helvetica').fontSize(8.5).fillColor('black');
  const agText = `${COMPANY_FULL}, a company incorporated under the Indian Companies Act, 1956, and having its registered office at ${REGD} and one of its branches at ${branchAddr} (hereinafter called 'the Company') agree to let on hire and Shri/Smt. ${t.name || '..............................'} residing at ${t.address || '......................................................................'} (hereinafter called the Hirer(s)) agree to take on hire, subject to the terms and conditions printed overleaf, the Company's Hi-Tech Locker No. ${t.locker_number || '........'}, Key No. ................., Locker type ${t.locker_size || '........'}, Cabinet No. ................., for a period of 12 months from the ${dayStr} day of ${monthStr} 20${yearStr} at a rental of ${rentStr} ${rentWordsStr} for the said period. Unless and until determined in accordance with the terms and conditions noted herein, the hiring will continue to like periods, upon the terms and conditions given hereunder, at periodical rentals in force which shall be payable in advance on the last day of the preceding period for the next ensuing period.`;
  doc.text(agText, M, y, { width: W - 2 * M - 150, align: 'justify', lineGap: 1.5 });
  y = doc.y + 10;

  doc.font('Helvetica').fontSize(8.5);
  tx(doc, 'Access to the said locker shall be had by the Hirer(s) (Pl tick):', M, y);
  y += 15;
  let cx = M;
  ['Single', 'Anyone', 'Joint'].forEach(mode => { cx = checkbox(doc, mode, cx, y) + 12; });
  y += 18;

  doc.font('Helvetica').fontSize(8.5).fillColor('black');
  tx(doc, 'On death of all the Hirer(s), save one, all the rights of the Hirer(s) hereunder shall', M, y); y += 11;
  tx(doc, 'vest in such surviving Hirer(s). The receipt of the above locker key is hereby', M, y); y += 11;
  tx(doc, 'acknowledged by the Hirer(s).', M, y); y += 14;

  tx(doc, 'The contents of the agreement and the terms and conditions and rules printed overleaf', M, y); y += 11;
  tx(doc, 'have been read by/explained to and understood by the Hirer/s and he/she/they', M, y); y += 11;
  tx(doc, 'agree/consent to abide and be bound by the same. In witness whereof the Hirer(s)', M, y); y += 11;
  tx(doc, 'and the Company have executed this agreement on the date and year mentioned above.', M, y); y += 16;

  doc.save().fillColor(GOLD).rect(M, y, W - 2 * M, 16).fill().restore();
  doc.font('Helvetica-Bold').fontSize(9).fillColor('white');
  tx(doc, 'S.No.', M + 10, y + 3);
  tx(doc, 'Name of the Hirer(s)', W / 2 - 60, y + 3);
  tx(doc, 'Signature', W - M - 90, y + 3);
  doc.fillColor('black');
  y += 18;

  for (let i = 1; i <= 3; i++) {
    doc.save().strokeColor('#dddddd').lineWidth(0.5).rect(M, y, W - 2 * M, 20).stroke().restore();
    doc.font('Helvetica').fontSize(8);
    tx(doc, String(i), M + 15, y + 5);
    if (i === 1 && t.name) tx(doc, t.name, M + 55, y + 5);
    y += 20;
  }

  y += 10;
  doc.font('Helvetica-Bold').fontSize(8);
  tx(doc, `For ${COMPANY_FULL}`, M, y); y += 20;
  tx(doc, 'Authorised Signatory', M, y); y += 20;

  doc.font('Helvetica-Bold').fontSize(8).fillColor(DARK);
  const compUpper = COMPANY_FULL.toUpperCase();
  tx(doc, compUpper, (W - doc.widthOfString(compUpper)) / 2, y); y += 12;
  doc.font('Helvetica').fontSize(6.5).fillColor('#666666');
  let cinTxt = `CIN: ${CIN}`;
  tx(doc, cinTxt, (W - doc.widthOfString(cinTxt)) / 2, y); y += 9;
  let gstTxt = `GST: ${GST}`;
  tx(doc, gstTxt, (W - doc.widthOfString(gstTxt)) / 2, y); y += 9;
  let regTxt = `Regd. Office: ${REGD}`;
  tx(doc, regTxt, (W - doc.widthOfString(regTxt)) / 2, y); y += 9;
  let corpTxt = `Corp. Office: ${CORP}`;
  tx(doc, corpTxt, (W - doc.widthOfString(corpTxt)) / 2, y); y += 9;
  let phTxt = `Ph: ${PHONE}`;
  tx(doc, phTxt, (W - doc.widthOfString(phTxt)) / 2, y);
  doc.fillColor('black');

  drawFooter(doc, 'DFIN/ALT/02/Ver 1.0');
}

// ================================================================
// PAGE 4-5: TERMS & CONDITIONS
// ================================================================
function pageTerms(doc) {
  newPage(doc);
  let y = drawHeader(doc);
  y += 3;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(DARK);
  const tcMainTitle = 'SAFE DEPOSIT LOCKER HIRING AGREEMENT';
  tx(doc, tcMainTitle, (W - doc.widthOfString(tcMainTitle)) / 2, y);
  doc.fillColor('black');
  y += 16;
  doc.font('Helvetica-Bold').fontSize(9);
  const tcSubTitle = 'Terms and Conditions';
  tx(doc, tcSubTitle, (W - doc.widthOfString(tcSubTitle)) / 2, y);
  y += 16;

  const terms = [
    "It is hereby agreed that the relation of the Company and the Hirer(s) is that of a lessor and lessee. The Hirer(s) agree(s) to abide by the rules and regulations of the Company. The Hirer(s) also agree(s) to abide by any amendments to the rules and regulations, that the Company may introduce from time to time. Such amendments shall be notified in the Company's Notice Board / Website.",
    "The Hirer(s) shall have access to safe deposit locker during the branch working hours except Sundays and the public holidays listed in the Company's Notice Board / Website.",
    "The Company shall be at liberty to change the above timings for access to the Locker and may add such conditions as it may deem fit, and shall give notice to the Hirer(s) on the same and the Hirer(s) shall be bound by the same. For reasons of grave or urgent necessity or during extraordinary contingencies like war, riots, floods, pandemic, etc., the Company reserves the right to closing the Hi-Tech Locker for such period, as it may consider necessary.",
    "The KYC compliance including PAN is mandatory and applicable to all Locker Hirer(s).",
    "The Hirer shall have no right of property on locker but only an exclusive right of use thereof and access thereto during the period of this agreement and in accordance therewith. The Hirer shall not assign or sublet the locker or any part of it, nor permit it to be used for any purpose other than for deposit of documents, jewellery or other valuables, nor shall the Hirer use the locker for the deposit of any property of an explosive or destructive nature, weapons and/or any other items/things prohibited under law.",
    "The locker can only be operated upon by applying two keys, one of which will remain with the Hirer(s) and other with the Custodian of the Hi-Tech Locker. The mechanism of the locker provides for its automatic double locking, when it is locked by the Hirer(s). It cannot be re-opened unless both the Custodian's and the Hirer(s) keys are applied to it.",
    "The Hirer(s) is/are permitted to operate the locker with the key provided by the Company and no operation of the locker shall be permitted with a key other than the key provided by the Company at the time of executing the Agreement. If the key of the locker is lost by the Hirer(s) or stolen, Branch should be intimated in writing and request made for break open of the locker.",
    "The Locker is initially rented for a period of one year upon payment of the annual rent and three years rental as advance/as decided by the Company. Thereafter, it will be renewed from year to year by payment of the prevailing annual rent in advance.",
    "All rentals are payable strictly in advance as per the schedule of rates. The Company may enhance/revise the rents of locker, from time to time after giving notice to the Hirer(s). The Company reserves the right of refusing access to the locker, in event of the rental not paid when due whether the same has been demanded or not. If the locker is surrendered during the contract period, no refund will be made.",
    "An advance equivalent to three times the prevailing rental needs to be made at the time of hiring the locker. This amount will be refunded when the locker is surrendered and key thereof is returned to the Company in good condition and provided the Hirer(s) does/do not owe to the Company any amount by way of arrears of rent or other charges.",
    "This agreement can be terminated by either party by giving a written notice, at least seven days prior to the date on which the agreed period or hiring terminates, and the keys of the locker shall in such case be delivered by the Hirer to the Company during its working hours.",
    "If no such notice as aforesaid is received prior to the date of termination and also the Hirer(s) locker key is not returned by the Hirer(s), then the period of hiring of the Locker shall be considered renewed but this condition is without prejudice to the rights of the Company accrued in the meantime.",
    "Any change in the addresses of the Hirer(s) should be intimated to the Company immediately along with a valid address proof.",
    "The Company will give due cognizance to orders received from a competent authority having statutory powers for freezing/unfreezing of locker.",
    "Force Majeure: During the continuance of this agreement, the Company shall not be responsible, notwithstanding anything to the contrary in Section 152 of the Indian Contract Act, for any loss or deterioration of or damage to the contents in the Hi-Tech Locker whether caused by rain, fire, flood, earthquake, lightning, civil commotion, riot or any other similar cause(s) not in the control of the Company.",
    "Hirer(s) are required to make at least one operation in a year as per the extant guidelines. In case of non-operation of the locker for one year, the Company shall notify and call upon the Hirer to either operate the locker or surrender it within a specified period.",
    "In the event of the Hirer(s) not providing the reason for non-operation of the locker or the reason is not found to be genuine, Company shall after giving due notice to the Hirer(s) at his/her last known address, proceed with cancellation of the allotment of the locker to the Hirer(s) and break open the locker.",
    "Delay in payment of locker rent, beyond 30 days from the due date, will attract an interest @ 12% p.a. compounded quarterly. The hirer is advised to pay the rent promptly and avoid liability for interest.",
    "In case of default in payment of rent, the Company has the power, after issuing one month's notice to the registered address of the Hirer(s), to break open the Locker, make a list of the contents and may remove the contents to another safe place as the Company may deem fit.",
    "The Hirer(s) agree(s) that the Company may at any time, at its discretion and without assigning any reason call upon them to withdraw the articles from the said locker failing which the Company will be absolved from all responsibilities in respect to the articles.",
    "Online rent payment facility is provided for the convenience of the Hirer(s). The Company will not be liable for loss of money(s), if any, that might arise while transacting online.",
    "The contents of the Locker shall in no manner be considered insured by the Company, and we shall not have any liability to insure the contents of the locker against any risk whatsoever.",
    "The hiring agreement to use the Locker hereby granted is Non-transferable.",
    "In the event of shifting of branch on account or any reason including merger or closure of branch where the locker is located, the Company shall give public notice in two newspapers (English and one in vernacular language) and Customer shall be intimated at least one month in advance along with options for them to change or close the locker.",
    "Any dispute arising from this agreement shall be taken for settlement in the Court of Law and shall be strictly subject to the Jurisdiction of the Courts of Coimbatore.",
    "I/We have read and understood all the terms and conditions governing the hiring of safe deposit locker from your company which are described on this form and agree to be bound by these terms and conditions at all times while the locker is rented to me/us. I/We have also received a copy of the agreement.",
  ];

  doc.font('Helvetica').fontSize(7);
  terms.forEach((term, i) => {
    const numStr = `${i + 1}. ${term}`;
    const lineH = doc.heightOfString(numStr, { width: W - 2 * M - 15 }) + 4;

    if (y + lineH > H - 45) {
      drawFooter(doc, 'DFIN/ALT/02/Ver 1.0');
      newPage(doc);
      y = drawHeader(doc);
      y += 3;
      doc.font('Helvetica-Bold').fontSize(12).fillColor(DARK);
      const contMainT = 'SAFE DEPOSIT LOCKER HIRING AGREEMENT';
      tx(doc, contMainT, (W - doc.widthOfString(contMainT)) / 2, y);
      doc.fillColor('black');
      y += 16;
      doc.font('Helvetica-Bold').fontSize(9);
      const contSubT = 'Terms and Conditions (Contd.)';
      tx(doc, contSubT, (W - doc.widthOfString(contSubT)) / 2, y);
      y += 14;
      doc.font('Helvetica').fontSize(7);
    }

    doc.text(numStr, M + 5, y, { width: W - 2 * M - 15, align: 'justify', lineGap: 1 });
    y = doc.y + 3;
  });

  y += 12;
  doc.font('Helvetica-Bold').fontSize(8);
  tx(doc, 'Signature of the Hirer(s):', M, y);
  tx(doc, 'Signature of the Branch Manager:', W - M - 190, y);
  y += 16;
  doc.save().strokeColor(LGREY).lineWidth(0.5)
    .moveTo(M, y).lineTo(M + 170, y).stroke()
    .moveTo(W - M - 170, y).lineTo(W - M, y).stroke().restore();

  drawFooter(doc, 'DFIN/ALT/02/Ver 1.0');
}

// ================================================================
// PAGE 6: HIRER INFORMATION
// ================================================================
function pageHirerInfo(doc, t) {
  newPage(doc);
  let y = drawHeader(doc);
  y += 3;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK);
  const hirerTitle = 'HIRER INFORMATION';
  tx(doc, hirerTitle, (W - doc.widthOfString(hirerTitle)) / 2, y);
  doc.fillColor('black');
  y += 15;

  doc.font('Helvetica').fontSize(6.5).fillColor('#666666');
  tx(doc, '1. Please fill the form in CAPITAL LETTERS only, use black ink for signature.', M, y);
  tx(doc, '2. Fields marked * are mandatory.', M + 280, y);
  doc.fillColor('black');
  y += 14;

  y = sectionTitle(doc, 'Personal Details', y);
  y += 3;

  doc.font('Helvetica').fontSize(8);
  tx(doc, 'Title:', M, y);
  let cx = M + 35;
  ['Mr.', 'Ms.', 'Mrs.', 'Dr.', 'Other'].forEach(title => { cx = checkbox(doc, title, cx, y) + 6; });
  y += 18;

  labeledBox(doc, 'Paste Passport Size Colour\nPhoto of Hirer. Photo to\nbe signed across', W - M - 100, y, 100, 95);

  y = field(doc, 'Full Name *:', M, y, (t.name || '').toUpperCase(), 270, 75);
  y = field(doc, 'Father/Husband/Guardian *:', M, y, t.guardian_name || '', 230, 160);
  y += 2;
  y = field(doc, 'Date of Birth *:', M, y, t.dob || '', 95, 90);
  doc.font('Helvetica').fontSize(8);
  tx(doc, 'Gender:', M + 210, y - 14);
  cx = M + 255;
  ['Male', 'Female', 'Other'].forEach(g => { cx = checkbox(doc, g, cx, y - 16) + 4; });
  y = field(doc, 'Nationality:', M, y, t.nationality || 'Indian', 110, 70);
  doc.font('Helvetica').fontSize(8);
  tx(doc, 'Marital Status:', M + 210, y - 14);
  cx = M + 295;
  ['Married', 'Single', 'Others'].forEach(ms => { cx = checkbox(doc, ms, cx, y - 16) + 4; });
  y = field(doc, "Mother's Maiden Name:", M, y, '', 240, 130);

  doc.font('Helvetica').fontSize(6).fillColor(GREY);
  tx(doc, 'Hirer Signature', W - M - 75, y - 3);
  doc.fillColor('black');
  y += 6;

  // Contact Details
  y = sectionTitle(doc, 'Contact Details', y);
  y += 3;
  y = field(doc, 'Tel Res:', M, y, t.phone || '', 170, 55);
  y = field(doc, 'Tel Office:', M, y, '', 170, 60);
  field(doc, 'Extn:', M + 270, y - 16, '', 90, 35);
  y = field(doc, 'Email ID *:', M, y, t.email || '', 240, 60);
  y = field(doc, '2nd Email ID:', M, y, '', 230, 75);
  y = field(doc, 'Mobile (+91) *:', M, y, t.phone || '', 140, 85);
  field(doc, '2nd Mobile:', M + 270, y - 16, '', 110, 75);
  y += 6;

  // Permanent Address
  y = sectionTitle(doc, 'Permanent Address', y);
  y += 3;
  y = field(doc, 'Flat No. & Building *:', M, y, t.address || '', W - 2 * M - 120, 115);
  y = field(doc, 'Road No & Name:', M, y, '', W - 2 * M - 110, 105);
  y = field(doc, 'Landmark:', M, y, '', W - 2 * M - 75, 65);
  y = field(doc, 'City *:', M, y, t.city || '', 170, 40);
  field(doc, 'PIN Code *:', M + 270, y - 16, t.pincode || '', 75, 65);
  y = field(doc, 'State *:', M, y, t.state || '', 170, 42);
  field(doc, 'Country:', M + 270, y - 16, 'India', 75, 55);
  y += 6;

  // Residence Address
  doc.font('Helvetica-Bold').fontSize(8);
  tx(doc, 'Residence Address:', M, y);
  doc.font('Helvetica').fontSize(8);
  tx(doc, 'Same as Permanent Address?', M + 115, y);
  checkbox(doc, 'Yes', M + 280, y);
  checkbox(doc, 'No', M + 320, y);
  y += 14;
  y = field(doc, 'Flat No. & Building:', M, y, '', W - 2 * M - 120, 115);
  y = field(doc, 'Road No & Name:', M, y, '', W - 2 * M - 110, 105);
  y = field(doc, 'Landmark:', M, y, '', W - 2 * M - 75, 65);
  y = field(doc, 'City:', M, y, '', 170, 35);
  field(doc, 'PIN Code:', M + 270, y - 16, '', 75, 60);
  y = field(doc, 'State:', M, y, '', 170, 38);
  field(doc, 'Country:', M + 270, y - 16, '', 75, 55);

  drawFooter(doc, 'DFIN/ALT/03/Ver 1.0');
}

// ================================================================
// PAGE 7: KYC DETAILS
// ================================================================
function pageKYC(doc, t) {
  newPage(doc);
  let y = drawHeader(doc);
  y += 3;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK);
  const kycTitle = 'KYC DETAILS & PROOF';
  tx(doc, kycTitle, (W - doc.widthOfString(kycTitle)) / 2, y);
  doc.fillColor('black');
  y += 18;

  doc.font('Helvetica-Bold').fontSize(9).fillColor(RED);
  tx(doc, 'PAN CARD MANDATORY', M, y);
  doc.fillColor('black');
  field(doc, 'No.:', M + 150, y, t.bg_pan || '', 145, 28);
  y += 18;

  doc.font('Helvetica-Bold').fontSize(9).fillColor(RED);
  tx(doc, 'AADHAAR MANDATORY', M, y);
  doc.fillColor('black');
  field(doc, 'No.:', M + 150, y, t.bg_aadhaar || '', 145, 28);
  y += 20;

  doc.font('Helvetica-Bold').fontSize(7.5);
  tx(doc, '( AND )', M, y); y += 10;
  doc.font('Helvetica').fontSize(7);
  tx(doc, 'Passport ALONE will be accepted as both Proof of Identity and Proof of Address IF the address on the', M, y);
  y += 9;
  tx(doc, 'passport is the same as the Correspondence Address mentioned in the form:', M, y);
  y += 12;
  y = field(doc, 'Passport No.:', M, y, '', 110, 75);
  field(doc, 'Issued at:', M + 220, y - 16, '', 75, 55);
  field(doc, 'Issued Date:', M + 380, y - 16, '', 75, 70);

  doc.font('Helvetica-Bold').fontSize(7.5);
  tx(doc, '( OR )', M, y); y += 10;
  doc.font('Helvetica').fontSize(6.5);
  tx(doc, 'Any one document from each of the two columns below for Proof of Identity and Proof of Address:', M, y);
  y += 12;

  const idProofs = ['Passport (where address differs)', 'Voter ID card', 'Driving License', 'Aadhaar Card/Letter', 'Ration card with photo'];
  const addrProofs = ['Voter ID card', 'Driving License', 'Aadhaar Card/Letter', 'Ration card with photo', 'Electricity Bill with book copy', 'Telephone Bill (landline)', 'Bank account statement (3 months)', 'Bank Pass Book (authenticated)', 'Registered Lease Agreement', 'Property tax receipt with book copy'];

  const col1x = M, col2x = W / 2 + 10;
  const tw = W / 2 - M - 15;

  doc.save().fillColor(GOLD).rect(col1x, y, tw, 12).fill().rect(col2x, y, tw, 12).fill().restore();
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor('white');
  tx(doc, 'Sr.', col1x + 4, y + 2);
  tx(doc, 'Proof of Identity', col1x + 22, y + 2);
  tx(doc, 'Tick', col1x + tw - 22, y + 2);
  tx(doc, 'Sr.', col2x + 4, y + 2);
  tx(doc, 'Proof of Address', col2x + 22, y + 2);
  tx(doc, 'Tick', col2x + tw - 22, y + 2);
  doc.fillColor('black');
  y += 13;

  const maxRows = Math.max(idProofs.length, addrProofs.length);
  for (let i = 0; i < maxRows; i++) {
    doc.save().strokeColor('#eeeeee').lineWidth(0.5).rect(col1x, y, tw, 11).stroke().rect(col2x, y, tw, 11).stroke().restore();
    doc.font('Helvetica').fontSize(6.5).fillColor('black');
    if (i < idProofs.length) {
      tx(doc, String(i + 1), col1x + 6, y + 2);
      tx(doc, idProofs[i], col1x + 22, y + 2);
      doc.save().strokeColor(GOLD).rect(col1x + tw - 18, y + 1, 7, 7).stroke().restore();
    }
    if (i < addrProofs.length) {
      tx(doc, String(i + 1), col2x + 6, y + 2);
      tx(doc, addrProofs[i], col2x + 22, y + 2);
      doc.save().strokeColor(GOLD).rect(col2x + tw - 18, y + 1, 7, 7).stroke().restore();
    }
    y += 11;
  }

  y += 4;
  y = field(doc, 'Document No.:', M, y, '', 170, 80);
  y = field(doc, 'Issued at:', M, y, '', 110, 55);
  field(doc, 'Expiry Date:', M + 210, y - 16, '', 95, 75);
  y += 3;
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(RED);
  tx(doc, 'Note: Pls attach one self-attested photocopy of PAN Card, Proof of Identity and Proof of Address.', M, y);
  doc.fillColor('black');
  y += 8;
  doc.font('Helvetica').fontSize(6.5);
  tx(doc, `Originals will have to be produced for verification by BM, ${COMPANY_SHORT}.`, M, y);
  y += 12;

  // Additional Details
  doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK);
  tx(doc, 'ADDITIONAL DETAILS ON HIRER', M, y);
  doc.fillColor('black');
  y += 15;

  const additional = [
    ['Education', ['Professional', 'Post Graduate', 'Graduate', 'Non Graduate', 'Others']],
    ['Occupation', ['Salaried', 'Self-employed Professional', 'Self-employed Business', 'Farmer', 'Retired', 'Student', 'Home Maker', 'Others']],
    ['Profession', ['Doctor', 'Lawyer', 'Architect', 'CA-CS', 'IT Consultant', 'Others']],
    ['Line of Business', ['Manufacturing', 'Trading', 'Agricultural', 'CA-CS']],
    ['Residence Type', ['Owned', 'Rented', 'Ancestral', 'Company Provided']],
  ];

  additional.forEach(([label, opts]) => {
    doc.font('Helvetica-Bold').fontSize(7).fillColor(GOLD);
    tx(doc, label, M, y);
    doc.fillColor('black');
    let cx2 = M + 90;
    opts.forEach(opt => {
      if (cx2 + doc.font('Helvetica').fontSize(6.5).widthOfString(opt) + 22 > W - M) {
        y += 12; cx2 = M + 90;
      }
      cx2 = checkbox(doc, opt, cx2, y) + 4;
    });
    y += 15;
    doc.save().strokeColor('#eeeeee').lineWidth(0.5).moveTo(M, y - 3).lineTo(W - M, y - 3).stroke().restore();
  });

  doc.font('Helvetica-Bold').fontSize(7).fillColor(GOLD);
  tx(doc, 'Annual Income', M, y);
  doc.font('Helvetica').fontSize(6.5).fillColor('black');
  tx(doc, '(in lakhs)', M, y + 9);
  let cx3 = M + 90;
  ['Upto 1', '1 to 3', '3 to 6', '6 to 12', '12 to 25', '25 to 50', '50 to 100', 'Above 100'].forEach(inc => {
    if (cx3 + doc.widthOfString(inc) + 22 > W - M) { y += 12; cx3 = M + 90; }
    cx3 = checkbox(doc, inc, cx3, y) + 4;
  });

  drawFooter(doc, 'DFIN/ALT/04/Ver 1.0');
}

// ================================================================
// PAGE 8: DECLARATION, NOMINATION, WITNESSES (all on one page)
// ================================================================
function pageDeclaration(doc, t) {
  newPage(doc);
  let y = drawHeader(doc);
  y += 2;

  // Mode of Operation
  y = sectionTitle(doc, 'MODE OF OPERATION', y);
  y += 4;
  let cx = M + 8;
  ['Single', 'Anyone', 'Joint'].forEach(mode => { cx = checkbox(doc, mode, cx, y) + 20; });
  y += 18;

  // Declaration
  y = sectionTitle(doc, 'DECLARATION', y);
  y += 4;

  const declarations = [
    `I/We request you to allot me/us a Locker of Type ${t.locker_size || '......'} in your branch as per particulars furnished in this application.`,
    `I/We agree to abide by the rules and regulations of the Company as mentioned herein and in the Hi-Tech Locker Hiring Agreement.`,
    'I/We shall not assign or sublet the locker or any part of it, nor permit it to be used for any purpose other than for deposit of documents, jewellery or other valuables.',
    'I/We shall not use the locker for the deposit of any property of an explosive or destructive nature, weapons and/or any other items/things prohibited under law.',
  ];

  doc.font('Helvetica').fontSize(7.5);
  declarations.forEach(decl => {
    tx(doc, '\u2022', M + 8, y);
    doc.text(decl, M + 18, y, { width: W - 2 * M - 25, align: 'justify', lineGap: 0.5 });
    y = doc.y + 3;
  });

  y += 2;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(GOLD);
  tx(doc, 'Signature:', M, y);
  doc.fillColor('black');
  labeledBox(doc, 'Hirer Signature', M + 60, y + 2, 110, 35);
  y += 42;

  // Nomination
  y = sectionTitle(doc, 'NOMINATION', y);
  y += 2;
  doc.font('Helvetica').fontSize(7).fillColor('black');
  doc.text("I/We nominate the following person whose name and address appears below to withdraw/take delivery of all the documents/jewellery/other contents from the locker standing in my/our name(s) after my/our/minor's death or disability.", M, y, { width: W - 2 * M, align: 'justify', lineGap: 0.5 });
  y = doc.y + 4;

  y = field(doc, 'Nominee Name *:', M, y, t.nominee_name || '', 270, 100);
  y = field(doc, 'Flat No. & Building:', M, y, '', 270, 115);
  y = field(doc, 'Road No & Name:', M, y, '', 270, 105);
  y = field(doc, 'Landmark:', M, y, '', 270, 65);
  y = field(doc, 'City:', M, y, '', 145, 35);
  field(doc, 'PIN Code:', M + 240, y - 16, '', 75, 60);
  y = field(doc, 'State:', M, y, '', 145, 38);
  field(doc, 'Country:', M + 240, y - 16, '', 75, 55);
  y = field(doc, 'Mobile (+91) *:', M, y, t.nominee_phone || '', 140, 85);
  y = field(doc, 'Date of Birth:', M, y, '', 95, 80);
  field(doc, 'Relationship with Hirer:', M + 240, y - 16, t.nominee_relation || '', 95, 135);

  y += 2;
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(RED);
  tx(doc, 'To be filled if nominee is a minor:', M, y);
  doc.fillColor('black');
  doc.font('Helvetica').fontSize(6.5);
  tx(doc, 'As nominee is a minor as on this date, I appoint', M + 155, y);
  y += 12;
  cx = M;
  ['Mr.', 'Ms.', 'Mrs.'].forEach(title => { cx = checkbox(doc, title, cx, y) + 2; });
  doc.save().strokeColor(LGREY).lineWidth(0.5).moveTo(cx + 3, y + 9).lineTo(cx + 190, y + 9).stroke().restore();
  y += 10;
  doc.font('Helvetica').fontSize(6.5);
  tx(doc, 'to withdraw/take delivery of all the documents/jewellery/other contents from the locker on behalf of the', M, y);
  y += 8;
  tx(doc, "nominee after my/our/minor's death during the minority of the nominee.", M, y);
  y += 14;

  field(doc, 'Date:', M, y, '', 75, 32);
  field(doc, 'Place:', M + 170, y, '', 110, 38);
  y += 18;

  doc.font('Helvetica-Bold').fontSize(8).fillColor(GOLD);
  tx(doc, 'Signature:', M, y);
  doc.fillColor('black');
  labeledBox(doc, 'Hirer', M + 60, y + 2, 90, 28);
  y += 35;

  // Witnesses - side by side
  const wY = y;
  const wColW = (W - 2 * M - 20) / 2;
  for (let wi = 0; wi < 2; wi++) {
    const wx = M + wi * (wColW + 20);
    const wn = wi === 0 ? '1st' : '2nd';
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(GOLD);
    tx(doc, `${wn} Witness:`, wx, wY);
    doc.fillColor('black');
    field(doc, 'Name:', wx, wY + 14, '', wColW - 45, 38);
    field(doc, 'Address:', wx, wY + 30, '', wColW - 50, 50);
    field(doc, 'Signature:', wx, wY + 46, '', wColW - 60, 60);
  }
  y = wY + 62;

  drawFooter(doc, 'DFIN/ALT/05/Ver 1.0');
}

// ================================================================
// PAGE 9: ACKNOWLEDGEMENT + COMPANY USE
// ================================================================
function pageAcknowledgement(doc, t, branch, locker) {
  newPage(doc);
  let y = drawHeader(doc);
  y += 6;

  y = sectionTitle(doc, 'ACKNOWLEDGEMENT OF HIRER', y);
  y += 6;
  doc.font('Helvetica').fontSize(9).fillColor('black');
  tx(doc, `I/We hereby acknowledge receipt of Locker No. ${t.locker_number || '__________'}  Key No. __________`, M, y);
  y += 25;

  doc.font('Helvetica-Bold').fontSize(8).fillColor(GOLD);
  tx(doc, 'Signature:', M, y);
  doc.fillColor('black');
  labeledBox(doc, 'Hirer', M + 60, y + 3, 120, 40);
  y += 55;

  // Divider
  doc.save().strokeColor(GOLD).lineWidth(1).dash(6, { space: 3 }).moveTo(M, y).lineTo(W - M, y).stroke().undash().restore();
  y += 20;

  // Company use section
  doc.save().fillColor(GOLD).rect(M, y, W - 2 * M, 20).fill().restore();
  doc.font('Helvetica-Bold').fontSize(11).fillColor('white');
  const compUseTitle = "FOR COMPANY'S USE ONLY";
  tx(doc, compUseTitle, (W - doc.widthOfString(compUseTitle)) / 2, y + 4);
  doc.fillColor('black');
  y += 26;

  y = field(doc, 'Agreement No.:', M, y, t.agreement_no || '', 150, 95);
  field(doc, 'Allotment Date:', W / 2 + 10, y - 16, formatDate(t.allotment_date), 115, 95);
  y = field(doc, 'Scheme:', M, y, 'Annual', 115, 55);
  field(doc, 'Locker Type:', W / 2 + 10, y - 16, locker.size || t.locker_size || '', 115, 80);
  y = field(doc, 'Locker No.:', M, y, t.locker_number || '', 115, 70);
  field(doc, 'Cabinet No.:', W / 2 + 10, y - 16, '', 115, 80);
  y += 2;
  y = field(doc, 'Received Locker Rent: Rs.', M, y, t.rent_amount ? formatRupees(t.rent_amount) : '', 115, 155);
  y = field(doc, 'Received Deposit: Rs.', M, y, t.deposit_amount ? formatRupees(t.deposit_amount) : '', 115, 135);

  y += 8;
  doc.font('Helvetica').fontSize(8);
  tx(doc, 'Remarks, if any:', M, y);
  y += 12;
  doc.save().strokeColor(LGREY).lineWidth(0.5).rect(M, y, W - 2 * M, 30).stroke().restore();
  y += 40;

  // Signature areas
  const mid = W / 2;
  doc.save().strokeColor(LGREY).lineWidth(0.5)
    .moveTo(M, y).lineTo(mid - 20, y).stroke()
    .moveTo(mid + 20, y).lineTo(W - M, y).stroke().restore();
  y += 4;
  doc.font('Helvetica-Bold').fontSize(8);
  tx(doc, 'Signature', M, y);
  tx(doc, 'Signature', mid + 20, y);
  y += 16;
  y = field(doc, 'Name:', M, y, '', 140, 40);
  field(doc, 'Name:', mid + 20, y - 16, '', 140, 40);
  y += 3;
  doc.font('Helvetica-Bold').fontSize(7);
  tx(doc, 'Customer Service Officer', M, y);
  tx(doc, 'Branch Manager', mid + 20, y);

  drawFooter(doc, 'DFIN/ALT/06/Ver 1.0');
}

// ================================================================
// MAIN: Generate PDF Buffer
// ================================================================
function generatePdfBuffer(tenant, branch, locker) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const t = Object.assign({}, tenant, {
        locker_number: tenant.locker_number || (locker && locker.number) || '',
        locker_size: tenant.locker_size || (locker && locker.size) || '',
      });

      page1(doc, t, branch || {});
      page2(doc, t, branch || {});
      page3(doc, t, branch || {});
      pageTerms(doc);
      pageHirerInfo(doc, t);
      pageKYC(doc, t);
      pageDeclaration(doc, t);
      pageAcknowledgement(doc, t, branch || {}, locker || {});

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generatePdfBuffer };
