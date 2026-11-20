import type { DocumentLine, DocumentTotals, PaymentMethod } from '@brand/shared';
import { amountInWords } from './amount-in-words.js';
import { A4, type Align, PdfDocument, wrapText } from './pdf-writer.js';

export interface Party {
  name: string;
  lines: string[];
}

/** Everything printed on an invoice or credit note, taken from the stored snapshot. */
export interface TaxDocumentView {
  kind: 'invoice' | 'credit_note';
  number: string;
  issuedAt: Date;
  seller: {
    legalName: string;
    address: string;
    gstin: string;
    stateCode: string;
    fssaiLicenceNo: string;
  };
  buyer: Party;
  placeOfSupply: { code: string; name: string };
  orderNumber: string;
  orderDate: Date;
  lines: DocumentLine[];
  totals: DocumentTotals;
  /** Invoice only: how it was paid (wallet credit counts as payment). */
  payment?: { method: PaymentMethod; walletPaise: number };
  /** Credit note only. */
  against?: { invoiceNumber: string; invoiceDate: Date; reason: string };
  /** Stamped on documents produced outside production. */
  specimen: boolean;
}

const MARGIN = 40;
const RIGHT = A4.width - MARGIN;
const CONTENT = RIGHT - MARGIN;
const BOTTOM = A4.height - 60;

const dateFormat = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});
const formatDate = (d: Date) => dateFormat.format(d);

/** 12345678 → "1,23,456.78" (Indian grouping, always two decimals). */
export function formatAmount(paise: number): string {
  const whole = String(Math.floor(paise / 100));
  const grouped =
    whole.length <= 3
      ? whole
      : `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}`;
  return `${grouped}.${String(paise % 100).padStart(2, '0')}`;
}

/** 500 → "5%", 1250 → "12.5%". */
export function formatRate(bps: number): string {
  const whole = Math.floor(bps / 100);
  const fraction = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}%`;
}

interface Column {
  title: string;
  width: number;
  align: Align;
  cell: (line: DocumentLine, index: number) => string;
}

function columns(intraState: boolean): Column[] {
  const tax: Column[] = intraState
    ? [
        { title: 'CGST', width: 52, align: 'right', cell: (l) => formatAmount(l.cgstPaise) },
        { title: 'SGST', width: 52, align: 'right', cell: (l) => formatAmount(l.sgstPaise) },
      ]
    : [{ title: 'IGST', width: 104, align: 'right', cell: (l) => formatAmount(l.igstPaise) }];
  return [
    { title: '#', width: 18, align: 'left', cell: (_, i) => String(i + 1) },
    { title: 'Description', width: 155, align: 'left', cell: (l) => l.description },
    { title: 'HSN', width: 42, align: 'left', cell: (l) => l.hsnCode },
    { title: 'Qty', width: 28, align: 'right', cell: (l) => String(l.quantity) },
    {
      title: 'Taxable value',
      width: 62,
      align: 'right',
      cell: (l) => formatAmount(l.taxableValuePaise),
    },
    { title: 'GST rate', width: 44, align: 'right', cell: (l) => formatRate(l.gstRateBps) },
    ...tax,
    { title: 'Total', width: 62, align: 'right', cell: (l) => formatAmount(l.totalPaise) },
  ];
}

/** Renders a GST tax invoice or credit note as a PDF. */
export function renderTaxDocument(view: TaxDocumentView): Buffer {
  const isInvoice = view.kind === 'invoice';
  const title = isInvoice ? 'TAX INVOICE' : 'CREDIT NOTE';
  const pdf = new PdfDocument(`${title} ${view.number}`);
  const intraState = view.seller.stateCode === view.placeOfSupply.code;
  let y = MARGIN + 12;

  // Heading
  pdf.text(MARGIN, y, title, { size: 16, font: 'bold' });
  pdf.text(RIGHT, y, 'Original for recipient', { size: 8, align: 'right', gray: 0.35 });
  y += 16;
  if (view.specimen) {
    pdf.text(MARGIN, y, 'SPECIMEN - NOT A VALID TAX DOCUMENT (test data)', {
      size: 9,
      font: 'bold',
      gray: 0.45,
    });
    y += 12;
  }
  y += 10;

  // Seller (left) and document details (right)
  const top = y;
  pdf.text(MARGIN, y, view.seller.legalName, { size: 10, font: 'bold' });
  y += 13;
  for (const line of wrapText(view.seller.address, 270, 8.5)) {
    pdf.text(MARGIN, y, line, { size: 8.5 });
    y += 11;
  }
  pdf.text(MARGIN, y, `GSTIN: ${view.seller.gstin}`, { size: 8.5 });
  y += 11;
  pdf.text(MARGIN, y, `FSSAI Lic. No.: ${view.seller.fssaiLicenceNo}`, { size: 8.5 });
  const sellerBottom = y + 11;

  const details: [string, string][] = isInvoice
    ? [
        ['Invoice No.', view.number],
        ['Invoice date', formatDate(view.issuedAt)],
      ]
    : [
        ['Credit note No.', view.number],
        ['Date', formatDate(view.issuedAt)],
        ['Against invoice', view.against?.invoiceNumber ?? ''],
        ['Invoice date', view.against ? formatDate(view.against.invoiceDate) : ''],
      ];
  details.push(
    ['Order No.', view.orderNumber],
    ['Order date', formatDate(view.orderDate)],
    ['Place of supply', `${view.placeOfSupply.name} (${view.placeOfSupply.code})`],
    ['Reverse charge', 'No'],
  );
  let dy = top;
  for (const [label, value] of details) {
    pdf.text(340, dy, label, { size: 8.5, gray: 0.35 });
    pdf.text(420, dy, value, { size: 8.5, font: 'bold' });
    dy += 12;
  }
  y = Math.max(sellerBottom, dy) + 8;

  // Buyer
  pdf.line(MARGIN, y, RIGHT, y, 0.5, 0.75);
  y += 14;
  pdf.text(MARGIN, y, 'Billed and shipped to', { size: 8.5, gray: 0.35 });
  y += 12;
  pdf.text(MARGIN, y, view.buyer.name, { size: 9.5, font: 'bold' });
  y += 12;
  for (const raw of view.buyer.lines) {
    for (const line of wrapText(raw, 300, 8.5)) {
      pdf.text(MARGIN, y, line, { size: 8.5 });
      y += 11;
    }
  }
  if (view.against) {
    y += 4;
    for (const line of wrapText(`Reason: ${view.against.reason}`, CONTENT, 8.5)) {
      pdf.text(MARGIN, y, line, { size: 8.5 });
      y += 11;
    }
  }
  y += 10;

  // Line items
  const cols = columns(intraState);
  const header = () => {
    pdf.rect(MARGIN, y, CONTENT, 16, 0.92);
    let x = MARGIN;
    for (const col of cols) {
      const tx = col.align === 'right' ? x + col.width - 3 : x + 3;
      pdf.text(tx, y + 11, col.title, { size: 7.5, font: 'bold', align: col.align });
      x += col.width;
    }
    y += 16;
  };
  header();
  view.lines.forEach((line, index) => {
    const descCol = cols[1]!;
    const wrapped = wrapText(line.description, descCol.width - 6, 8);
    const height = wrapped.length * 10 + 6;
    if (y + height > BOTTOM) {
      pdf.addPage();
      y = MARGIN + 10;
      header();
    }
    let x = MARGIN;
    for (const col of cols) {
      if (col === descCol) {
        wrapped.forEach((part, k) => pdf.text(x + 3, y + 11 + k * 10, part, { size: 8 }));
      } else {
        const tx = col.align === 'right' ? x + col.width - 3 : x + 3;
        pdf.text(tx, y + 11, col.cell(line, index), { size: 8, align: col.align });
      }
      x += col.width;
    }
    y += height;
    pdf.line(MARGIN, y, RIGHT, y, 0.3, 0.8);
  });

  // Totals
  const totals: [string, number, boolean][] = [
    ['Taxable value', view.totals.taxableValuePaise, false],
    ...(intraState
      ? ([
          ['CGST', view.totals.cgstPaise, false],
          ['SGST', view.totals.sgstPaise, false],
        ] as [string, number, boolean][])
      : ([['IGST', view.totals.igstPaise, false]] as [string, number, boolean][])),
    [isInvoice ? 'Invoice total (Rs.)' : 'Credit note total (Rs.)', view.totals.totalPaise, true],
  ];
  if (y + totals.length * 14 + 90 > BOTTOM) {
    pdf.addPage();
    y = MARGIN + 10;
  }
  y += 8;
  for (const [label, amount, strong] of totals) {
    y += 13;
    const font = strong ? 'bold' : 'regular';
    pdf.text(430, y, label, { size: strong ? 9.5 : 8.5, font, align: 'right' });
    pdf.text(RIGHT - 3, y, formatAmount(amount), {
      size: strong ? 9.5 : 8.5,
      font,
      align: 'right',
    });
  }
  y += 16;
  for (const line of wrapText(
    `Amount in words: ${amountInWords(view.totals.totalPaise)}`,
    CONTENT,
    8.5,
  )) {
    pdf.text(MARGIN, y, line, { size: 8.5 });
    y += 11;
  }

  if (view.payment) {
    y += 4;
    const { method, walletPaise } = view.payment;
    const rest = view.totals.totalPaise - walletPaise;
    if (walletPaise > 0) {
      pdf.text(MARGIN, y, `Paid with wallet credit: Rs. ${formatAmount(walletPaise)}`, {
        size: 8.5,
      });
      y += 11;
    }
    if (rest > 0) {
      const how = method === 'cod' ? 'Payable on delivery (cash)' : 'Paid online';
      pdf.text(MARGIN, y, `${how}: Rs. ${formatAmount(rest)}`, { size: 8.5 });
      y += 11;
    }
  }

  // Footer
  y += 24;
  pdf.text(RIGHT, y, `For ${view.seller.legalName}`, { size: 8.5, font: 'bold', align: 'right' });
  y += 26;
  pdf.text(RIGHT, y, 'Authorised signatory', { size: 8, align: 'right', gray: 0.35 });
  pdf.text(MARGIN, A4.height - 36, 'This is a computer-generated document.', {
    size: 7.5,
    gray: 0.45,
  });

  return pdf.toBuffer();
}
