declare module "pdf-parse" {
  interface PdfData { text: string }
  function pdfParse(data: Buffer): Promise<PdfData>;
  export default pdfParse;
}
