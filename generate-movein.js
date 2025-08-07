const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');

async function generateMoveInPDF(booking, outputPath) {
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

  const guestName = booking.guestName || 'Guest';
  const guestName2 = booking.guestName2 ? booking.guestName2 : '';
  const checkIn = booking.checkIn ? formatDate(booking.checkIn) : '___';
  const checkOut = booking.checkOut ? formatDate(booking.checkOut) : '___';
  const today = formatDate(new Date());

  // Page 1
  drawText(firstPage, ` ${guestName}`, 350, 780);
  drawText(firstPage, today, 545, 810);
  drawText(firstPage, '4317', 150, 765);
  drawText(firstPage, checkIn, 290, 765);
  drawText(firstPage, checkOut, 150, 745);
  drawText(firstPage, ` ${guestName}`, 370, 690);
  drawText(firstPage, 'Sol Baes', 240, 575);
  drawText(firstPage, '4317', 500, 575);
  drawText(firstPage, '09152151745', 500, 560);
  drawText(firstPage, `${guestName}`, 250, 530);
  drawText(firstPage, `${guestName2}`, 250, 518);
  drawText(firstPage, 'Adam Kischinovsky', 150, 365);
  drawText(firstPage, 'Adam Kischinovsky', 150, 300);

  const signatureImageBytes = fs.readFileSync(path.join(__dirname, 'Min_underskrift.PNG'));
  const signatureImage = await pdfDoc.embedPng(signatureImageBytes);
  const signatureDims = signatureImage.scale(0.3);

  firstPage.drawImage(signatureImage, { x: 150, y: 350, width: signatureDims.width, height: signatureDims.height });
  firstPage.drawImage(signatureImage, { x: 150, y: 290, width: signatureDims.width, height: signatureDims.height });
  firstPage.drawImage(signatureImage, { x: 600, y: 290, width: signatureDims.width, height: signatureDims.height });

  // Page 2
  drawText(secondPage, '4317', 100, 495);            // Unit number
  drawText(secondPage, today, 220, 495);             // Today's date
  drawText(secondPage, 'Adam Kischinovsky', 70, 465); // applicant name
  secondPage.drawImage(signatureImage, { x: 70, y: 450, width: signatureDims.width, height: signatureDims.height });
  drawText(secondPage, 'X', 270, 478);               // Mark SPA/representative
  drawText(secondPage, guestName, 40, 372);         // Guest name
  drawText(secondPage, guestName2, 40, 360);

  // Page 3
  drawText(thirdPage, '4317', 100, 468);             // Unit number
  thirdPage.drawImage(signatureImage, {              // Signature
    x: 300,
    y: 110,
    width: signatureDims.width,
    height: signatureDims.height
  });

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, pdfBytes);
}

module.exports = generateMoveInPDF;