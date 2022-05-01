import * as fs from "node:fs/promises";
import * as process from "node:process";
import { Buffer } from "node:buffer";
import * as ai from "@google-cloud/documentai";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import * as React from "react";
import { basename } from "node:path";

type DocumentAIOCR = ai.protos.google.cloud.documentai.v1.IProcessResponse;
async function runOCR(imageFilePath: string): Promise<DocumentAIOCR> {
  const { DocumentProcessorServiceClient } = ai.v1;

  // Instantiates a client
  const client = new DocumentProcessorServiceClient({
    apiEndpoint: "eu-documentai.googleapis.com",
  });

  // The full resource name of the processor, e.g.:
  // projects/project-id/locations/location/processor/processor-id
  // You must create new processors in the Cloud Console first
  const gcloudName = `projects/436669737714/locations/eu/processors/bade0ba9e61389cc`;

  // Read the file into memory.
  const imageFile = await fs.readFile(imageFilePath);

  // Convert the image data to a Buffer and base64 encode it.
  const encodedImage = Buffer.from(imageFile).toString("base64");

  const request = {
    name: gcloudName,
    rawDocument: {
      content: encodedImage,
      mimeType: "image/jpeg",
    },
  };

  // Recognizes text entities in the PDF document
  const [result] = await client.processDocument(request);
  if (result.document && result.document.pages) {
    for (const page of result.document.pages) {
      if (page.image?.content) delete page.image.content;
    }
  }
  return result;
}

type Discriminate<U, K extends PropertyKey> = U extends any
  ? K extends keyof U
    ? U
    : U & Record<K, unknown>
  : never;

function inOperator<K extends PropertyKey, T>(
  k: K,
  o: T
): o is Discriminate<T, K> {
  return k in o;
}

function toHOCR(
  imageFileName: string,
  [w, h]: [number, number],
  page: ai.protos.google.cloud.documentai.v1.Document.IPage,
  documentText: string
): JSX.Element {
  if (!page.lines) throw Error("no lines");
  // todo: ocrp_lang, ocrp_poly, ocrp_nlp
  return (
    <html>
      <head>
        <meta
          name="ocr-system"
          content="google document ai via @phiresky/ocr-pdf-via-document-ai"
        />
        <meta name="ocr-capabilities" content="" />
      </head>
      <div
        className="ocr_page"
        title={`image "${imageFileName}"; bbox 0 0 ${w} ${h};`}
      >
        {page.lines?.map((line) => {
          const bbox = line.layout?.boundingPoly?.normalizedVertices;
          if (!bbox) throw Error("no bbox");
          const x = bbox.map((b) => Math.round(w * b.x!));
          const y = bbox.map((b) => Math.round(h * b.y!));
          const bbox2 = `${Math.min(...x)} ${Math.min(...y)} ${Math.max(
            ...x
          )} ${Math.max(...y)}`;
          const textSegs = line.layout?.textAnchor?.textSegments;
          if (!textSegs || textSegs.length !== 1)
            throw Error("expected exactly one text seg");
          let text = documentText.slice(
            textSegs[0].startIndex,
            textSegs[0].endIndex
          );
          if(text[text.length - 1] !== "\n") throw Error(`expected \\n at end of line, got ${JSON.stringify(text)}`);
          text = text.slice(0, -1);
          console.log(text);
          return (
            <span className="ocr_line" title={`bbox ${bbox2}`}>{text}</span>
          );
        })}
      </div>
      <script src="https://unpkg.com/hocrjs" />
    </html>
  );
}
async function main(imageFilePath: string) {
  const jsonFilePath = imageFilePath + ".json";
  const txtFilePath = imageFilePath + ".ocr.txt";
  const hocrFilePath = imageFilePath + ".hocr";
  let ocr: DocumentAIOCR;
  try {
    ocr = JSON.parse(await fs.readFile(jsonFilePath, "utf8"));
  } catch (e) {
    if (
      !e ||
      typeof e !== "object" ||
      !inOperator("code", e) ||
      e.code !== "ENOENT"
    )
      throw e;
    ocr = await runOCR(imageFilePath);
    await fs.writeFile(jsonFilePath, JSON.stringify(ocr, null, 2), {
      flag: "wx",
    });
    if (ocr.document?.text) {
      await fs.writeFile(txtFilePath, ocr.document.text, {
        flag: "wx",
      });
    }
  }

  if (ocr.document?.pages?.length !== 1) throw Error("not exactly one page");
  if (!ocr.document.text) throw Error("no text");
  const hocr = toHOCR(
    basename(imageFilePath),
    [ocr.document.pages[0].image?.width!, ocr.document.pages[0].image?.height!],
    ocr.document.pages[0],
    ocr.document.text
  );
  const hocrString = renderToStaticMarkup(hocr);
  await fs.writeFile(hocrFilePath, hocrString, { flag: "w" });
}

const args = process.argv.slice(2) as [string];
main(...args).catch((err) => {
  console.error(err);
  process.exit(1);
});
