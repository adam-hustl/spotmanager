const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');

async function generateMoveInPDF(booking, unit, outputPath, opts = {}) {
  const {
    loadSignature, // optional async (key) => Buffer
  } = opts;

  const templatePath = path.join(__dirname, 'together_move_in.pdf');
  const formBytes = fs.readFileSync(templatePath);
  const pdfDoc = await PDFDocument.load(formBytes);
  const pages = pdfDoc.getPages();
  const firstPage = pages[0];
  const secondPage = pages[1];
  const thirdPage = pages[2];

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const drawText = (page, text, x, y, size = 11) => {
    page.drawText(text, { x, y, size, font });
  };

  const formatDate = (isoDate) => {
    const date = new Date(isoDate);
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const yy = String(date.getFullYear()).slice(-2);
    return `${mm}/${dd}-${yy}`;
  };

  const guestName = booking?.guestName || 'Guest';
  const guestName2 = booking?.guestName2 ? booking.guestName2 : '';
  const checkIn = booking?.checkIn ? formatDate(booking.checkIn) : '___';
  const checkOut = booking?.checkOut ? formatDate(booking.checkOut) : '___';
  const today = formatDate(new Date());
  const unitNum = unit?.unit_number || '___';
  const ownerName = unit?.unit_owner_name || '___';
  const ownerPhone = unit?.unit_phone || '___';

  // Page 1
  drawText(firstPage, ` ${guestName}`, 350, 780);
  drawText(firstPage, today, 545, 810);
  drawText(firstPage, unitNum, 150, 765);
  drawText(firstPage, checkIn, 290, 765);
  drawText(firstPage, checkOut, 150, 745);
  drawText(firstPage, ` ${guestName}`, 370, 690);
  drawText(firstPage, ownerName, 240, 575);
  drawText(firstPage, unitNum, 500, 575);
  drawText(firstPage, ownerPhone, 500, 560);
  drawText(firstPage, `${guestName}`, 250, 530);
  drawText(firstPage, `${guestName2}`, 250, 518);
  drawText(firstPage, ownerName, 150, 365);
  drawText(firstPage, ownerName, 150, 300);

  let signatureImage = null;
  let signatureDims = null;
  if (loadSignature && unit?.signature_file_key) {
    try {
      const sigBytes = await loadSignature(unit.signature_file_key);
      if (sigBytes) {
        const ext = (path.extname(unit.signature_file_key || '').toLowerCase()) || '.png';
        if (ext === '.jpg' || ext === '.jpeg') {
          signatureImage = await pdfDoc.embedJpg(sigBytes);
        } else {
          signatureImage = await pdfDoc.embedPng(sigBytes);
        }
        signatureDims = signatureImage.scale(0.3);
      }
    } catch (_) {
      signatureImage = null;
    }
  }

  const drawSignature = (page, x, y) => {
    if (signatureImage && signatureDims) {
      page.drawImage(signatureImage, { x, y, width: signatureDims.width, height: signatureDims.height });
    } else {
      drawText(page, '(no signature)', x, y + 10, 9);
    }
  };

  drawSignature(firstPage, 150, 350);
  drawSignature(firstPage, 150, 290);
  drawSignature(firstPage, 600, 290);

  // Page 2
  drawText(secondPage, unitNum, 100, 495);            // Unit number
  drawText(secondPage, today, 220, 495);             // Today's date
  drawText(secondPage, ownerName, 70, 465); // applicant name
  drawSignature(secondPage, 70, 450);
  drawText(secondPage, 'X', 270, 478);               // Mark SPA/representative
  drawText(secondPage, guestName, 40, 372);         // Guest name
  drawText(secondPage, guestName2, 40, 360);

  // Page 3
  drawText(thirdPage, unitNum, 100, 468);             // Unit number
  drawSignature(thirdPage, 300, 110);

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, pdfBytes);
}

module.exports = generateMoveInPDF;
