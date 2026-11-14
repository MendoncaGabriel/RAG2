declare module "pdf-parse" {
  interface PdfData { text: string }
  function pdfParse(data: Buffer, options?: { pagerender?: (pageData: any) => Promise<string>; max?: number }): Promise<PdfData>;
  export default pdfParse;
}
