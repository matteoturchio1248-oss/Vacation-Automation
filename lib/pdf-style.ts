import type { jsPDF } from "jspdf";

export const pdfColors = { brown: [69, 34, 30], gold: [182, 160, 55], muted: [117, 110, 104], line: [229, 226, 222], soft: [245, 241, 230] } as const;
let logoPromise: Promise<string | undefined> | undefined;
export function loadPdfLogo() {
  logoPromise ??= fetch("/sfte-logo.png").then((response) => { if (!response.ok) throw new Error("Logo unavailable"); return response.blob(); }).then((blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob);
  })).catch(() => undefined);
  return logoPromise;
}

export function brandedPdfHeader(pdf: jsPDF, title: string, companyName: string, subtitle: string, logo?: string) {
  const width = pdf.internal.pageSize.getWidth();
  pdf.setFillColor(...pdfColors.brown); pdf.rect(0, 0, width, 82, "F");
  pdf.setFillColor(...pdfColors.gold); pdf.rect(0, 82, width, 3, "F");
  if (logo) pdf.addImage(logo, "PNG", 38, 12, 62, 49.5);
  const left = logo ? 118 : 42;
  pdf.setTextColor(255, 255, 255); pdf.setFont("helvetica", "bold"); pdf.setFontSize(16);
  pdf.text(title, left, 32, { maxWidth: width - left - 42 });
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.text(companyName, left, 51, { maxWidth: width - left - 42 });
  pdf.setTextColor(222, 208, 149); pdf.setFontSize(8); pdf.text(subtitle, left, 66, { maxWidth: width - left - 42 });
}

export function brandedPdfFooter(pdf: jsPDF, generated = new Date().toLocaleDateString("en-CA")) {
  const total = pdf.getNumberOfPages();
  const width = pdf.internal.pageSize.getWidth();
  const height = pdf.internal.pageSize.getHeight();
  for (let page = 1; page <= total; page++) {
    pdf.setPage(page); pdf.setDrawColor(...pdfColors.line); pdf.line(42, height - 34, width - 42, height - 34);
    pdf.setTextColor(...pdfColors.muted); pdf.setFont("helvetica", "normal"); pdf.setFontSize(8);
    pdf.text("SFTE People · Confidential employee record", 42, height - 20);
    pdf.text(`${generated} · ${page} / ${total}`, width - 42, height - 20, { align: "right" });
  }
}

export type PdfSection = { title: string; fields: Array<{ label: string; value: string; fullWidth?: boolean }> };
export async function createVacationRecordPdf(options: { companyName: string; requestId: number; status: string; sections: PdfSection[] }, logo?: string) {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "pt", format: "letter" });
  const margin = 42;
  const width = pdf.internal.pageSize.getWidth();
  const bottom = pdf.internal.pageSize.getHeight() - 48;
  let y = 112;
  const header = () => brandedPdfHeader(pdf, "Vacation request record", options.companyName, `Request #${options.requestId} · Payroll and approval record`, logo);
  header();
  function space(height: number) { if (y + height > bottom) { pdf.addPage(); header(); y = 112; } }
  pdf.setFillColor(...pdfColors.soft); pdf.roundedRect(margin, y - 10, 135, 28, 5, 5, "F");
  pdf.setTextColor(...pdfColors.brown); pdf.setFont("helvetica", "bold"); pdf.setFontSize(10); pdf.text(options.status.toUpperCase(), margin + 12, y + 8); y += 42;
  for (const section of options.sections) {
    space(80); pdf.setTextColor(...pdfColors.brown); pdf.setFont("helvetica", "bold"); pdf.setFontSize(11); pdf.text(section.title, margin, y);
    pdf.setDrawColor(...pdfColors.line); pdf.line(margin, y + 9, width - margin, y + 9); y += 32;
    for (let index = 0; index < section.fields.length;) {
      const first = section.fields[index++];
      const fields = [first];
      if (!first.fullWidth && section.fields[index] && !section.fields[index].fullWidth) fields.push(section.fields[index++]);
      const cellWidth = fields.length === 2 ? (width - margin * 2 - 24) / 2 : width - margin * 2;
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(10);
      const wrapped = fields.map((field) => pdf.splitTextToSize(field.value || "Not recorded", cellWidth) as string[]);
      const height = Math.max(...wrapped.map((lines) => lines.length)) * 14 + 26;
      space(height);
      fields.forEach((field, column) => {
        const x = margin + column * (cellWidth + 24);
        pdf.setTextColor(...pdfColors.muted); pdf.setFont("helvetica", "normal"); pdf.setFontSize(8); pdf.text(field.label.toUpperCase(), x, y);
        pdf.setTextColor(...pdfColors.brown); pdf.setFontSize(10); pdf.text(wrapped[column], x, y + 16, { lineHeightFactor: 1.4 });
      });
      y += height;
    }
    y += 10;
  }
  brandedPdfFooter(pdf);
  pdf.setProperties({ title: `Vacation request #${options.requestId}`, author: options.companyName, creator: "SFTE People" });
  return pdf;
}

export type WorkforcePdfOptions = {
  companyName: string; title: string; period: string; generated: string;
  headers: string[]; rows: Array<Array<string | number>>;
  bars?: Array<{ label: string; value: number; tone?: string }>;
  pie?: { title: string; segments: Array<{ label: string; value: number; color: string }> };
};

export async function createWorkforceReportPdf(options: WorkforcePdfOptions, logo?: string) {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
  const width = pdf.internal.pageSize.getWidth();
  const bottom = pdf.internal.pageSize.getHeight() - 48;
  const margin = 42;
  const usable = width - margin * 2;
  let y = 112;
  function header() { brandedPdfHeader(pdf, "Workforce report", options.companyName, options.title, logo); }
  function addPage() { pdf.addPage(); header(); y = 112; }
  function space(height: number) { if (y + height > bottom) addPage(); }
  header();
  pdf.setTextColor(...pdfColors.brown); pdf.setFont("helvetica", "bold"); pdf.setFontSize(18); pdf.text(options.title, margin, y);
  pdf.setTextColor(...pdfColors.muted); pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.text(options.period, margin, y + 20); y += 44;
  const chartTop = y;
  let barHeight = 0;
  if (options.bars?.length) {
    pdf.setTextColor(...pdfColors.brown); pdf.setFont("helvetica", "bold"); pdf.setFontSize(11); pdf.text("Headcount movement", margin, y);
    const maximum = Math.max(1, ...options.bars.map((bar) => Math.abs(bar.value)));
    options.bars.forEach((bar, index) => {
      const top = y + 25 + index * 34;
      pdf.setTextColor(...pdfColors.muted); pdf.setFontSize(9); pdf.text(bar.label, margin, top);
      pdf.setFillColor(...pdfColors.soft); pdf.roundedRect(margin + 76, top - 10, 200, 13, 3, 3, "F");
      const color = bar.tone === "negative" ? [172,57,57] as const : bar.tone === "positive" ? pdfColors.gold : pdfColors.brown;
      pdf.setFillColor(color[0], color[1], color[2]);
      if (bar.value !== 0) pdf.roundedRect(margin + 76, top - 10, Math.max(2, Math.abs(bar.value) / maximum * 200), 13, 3, 3, "F");
      pdf.setTextColor(...pdfColors.brown); pdf.text(String(bar.value), margin + 304, top, { align: "right" });
    });
    barHeight = options.bars.length * 34 + 32;
  }
  if (options.pie) {
    const chartX = options.bars?.length ? 410 : margin;
    const legendX = chartX + 160;
    const segments = options.pie.segments.filter((segment) => segment.value > 0);
    const total = segments.reduce((sum, segment) => sum + segment.value, 0);
    pdf.setTextColor(...pdfColors.brown); pdf.setFont("helvetica", "bold"); pdf.setFontSize(11); pdf.text(options.pie.title, chartX, y);
    const centerX = chartX + 68;
    const centerY = y + 85;
    const radius = 63;
    let angle = -Math.PI / 2;
    for (const segment of segments) {
      const sweep = segment.value / total * Math.PI * 2;
      const steps = Math.max(2, Math.ceil(sweep / .035));
      const points: number[][] = [[Math.cos(angle) * radius, Math.sin(angle) * radius]];
      let previousX = points[0][0]; let previousY = points[0][1];
      for (let step = 1; step <= steps; step++) {
        const current = angle + sweep * step / steps;
        const x = Math.cos(current) * radius; const py = Math.sin(current) * radius;
        points.push([x - previousX, py - previousY]); previousX = x; previousY = py;
      }
      const color = segment.color.replace("#", "");
      pdf.setFillColor(parseInt(color.slice(0, 2), 16), parseInt(color.slice(2, 4), 16), parseInt(color.slice(4, 6), 16));
      pdf.lines(points, centerX, centerY, [1, 1], "F", true); angle += sweep;
    }
    if (!total) { pdf.setFillColor(...pdfColors.soft); pdf.circle(centerX, centerY, radius, "F"); }
    let legendY = y + 28;
    for (const segment of segments) {
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(9);
      const lines = pdf.splitTextToSize(segment.label, width - margin - legendX - 42) as string[];
      const height = Math.max(20, lines.length * 12 + 9);
      if (legendY + height > bottom) { addPage(); legendY = y; }
      const color = segment.color.replace("#", "");
      pdf.setFillColor(parseInt(color.slice(0,2),16), parseInt(color.slice(2,4),16), parseInt(color.slice(4,6),16)); pdf.circle(legendX, legendY - 3, 4, "F");
      pdf.setTextColor(...pdfColors.brown); pdf.text(lines, legendX + 12, legendY); pdf.text(String(segment.value), width - margin, legendY, { align: "right" });
      legendY += height;
    }
    y = Math.max(y + 166, legendY + 12, chartTop + barHeight);
  } else y += barHeight;
  if (options.bars?.length || options.pie) y += 18;
  if (options.headers.length > 8) {
    // Wide employee files remain readable as labelled rows rather than tiny columns.
    for (const row of options.rows) {
      space(90); pdf.setFillColor(...pdfColors.soft); pdf.roundedRect(margin, y - 5, usable, 25, 4, 4, "F");
      pdf.setTextColor(...pdfColors.brown); pdf.setFont("helvetica", "bold"); pdf.setFontSize(10); pdf.text(String(row[0] ?? "Employee"), margin + 10, y + 11); y += 40;
      const cellWidth = (usable - 32) / 3;
      for (let start = 0; start < options.headers.length; start += 3) {
        pdf.setFont("helvetica", "normal"); pdf.setFontSize(9);
        const values = row.slice(start, start + 3).map((value) => pdf.splitTextToSize(String(value ?? "Not recorded"), cellWidth) as string[]);
        const height = Math.max(1, ...values.map((value) => value.length)) * 12 + 25;
        space(height);
        values.forEach((value, column) => { const x = margin + column * (cellWidth + 16); pdf.setTextColor(...pdfColors.muted); pdf.setFontSize(8); pdf.text(options.headers[start + column], x, y); pdf.setTextColor(...pdfColors.brown); pdf.setFontSize(9); pdf.text(value, x, y + 14); });
        y += height;
      }
      y += 18;
    }
  } else {
    const columnWidth = usable / Math.max(1, options.headers.length);
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(8);
    const headings = options.headers.map((heading) => pdf.splitTextToSize(heading.toUpperCase(), columnWidth - 16) as string[]);
    const headingHeight = Math.max(1, ...headings.map((heading) => heading.length)) * 10 + 18;
    function tableHeader() { space(headingHeight + 30); pdf.setFillColor(...pdfColors.soft); pdf.rect(margin, y, usable, headingHeight, "F"); pdf.setTextColor(...pdfColors.brown); pdf.setFont("helvetica", "bold"); pdf.setFontSize(8); headings.forEach((heading, index) => pdf.text(heading, margin + index * columnWidth + 8, y + 14)); y += headingHeight; }
    tableHeader();
    for (const row of options.rows) {
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(9);
      const values = row.map((value) => pdf.splitTextToSize(String(value ?? "Not recorded"), columnWidth - 16) as string[]);
      const height = Math.max(1, ...values.map((value) => value.length)) * 12 + 18;
      if (y + height > bottom) { addPage(); tableHeader(); }
      pdf.setTextColor(...pdfColors.brown); pdf.setFont("helvetica", "normal"); pdf.setFontSize(9);
      values.forEach((value, index) => pdf.text(value, margin + index * columnWidth + 8, y + 15));
      pdf.setDrawColor(...pdfColors.line); pdf.line(margin, y + height, width - margin, y + height); y += height;
    }
  }
  if (!options.rows.length) { space(30); pdf.setTextColor(...pdfColors.muted); pdf.setFontSize(10); pdf.text("No records match this report.", margin, y + 20); }
  brandedPdfFooter(pdf, options.generated);
  pdf.setProperties({ title: options.title, author: options.companyName, creator: "SFTE People" });
  return pdf;
}
