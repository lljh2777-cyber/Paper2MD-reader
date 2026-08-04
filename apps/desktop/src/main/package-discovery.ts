export function selectSourcePdfName(fileNames: string[]): string | undefined {
  const pdfNames = [...new Set(fileNames.filter((name) => name.toLowerCase().endsWith(".pdf")))]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const originNames = pdfNames.filter((name) => /(?:^|[_-])origin\.pdf$/i.test(name));
  if (originNames.length === 1) return originNames[0];
  return pdfNames.length === 1 ? pdfNames[0] : undefined;
}
