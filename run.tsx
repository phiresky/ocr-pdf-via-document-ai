import * as fs from "node:fs/promises";
import * as process from "node:process";
import { Buffer } from "node:buffer";
import * as ai from "@google-cloud/documentai";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import * as React from "react";
import { basename } from "node:path";
import binarySearch from "binary-search";
import {
  PageSizes,
  pdfDocEncodingDecode,
  PDFDocument,
  PDFFont,
  rgb,
  setCharacterSqueeze,
  setTextRenderingMode,
  StandardFonts,
  TextRenderingMode,
} from "pdf-lib";
import * as zlib from "zlib";
import fontkit from "@pdf-lib/fontkit";

import docai = ai.protos.google.cloud.documentai.v1;
async function runOCR(imageFilePath: string): Promise<docai.IProcessResponse> {
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

function assertArraySorted<T>(arr: T[], k: (t: T) => number) {
  let last = -Infinity;
  for (const e of arr) {
    const cur = k(e);
    if (!(cur >= last)) throw Error(`array unsorted`);
    last = cur;
  }
}
type SaneSeg = {
  startIndex: number;
  endIndex: number;
};
function getSeg(line: docai.Document.Page.ILine): SaneSeg {
  const textSegs = line.layout?.textAnchor?.textSegments;
  if (!textSegs || textSegs.length !== 1)
    throw Error("expected exactly one text seg");
  const textSeg = textSegs[0];
  if (
    textSeg.startIndex === null ||
    textSeg.startIndex === undefined ||
    textSeg.endIndex === null ||
    textSeg.endIndex === undefined
  )
    throw Error("never ahppen");
  return { startIndex: +textSeg.startIndex, endIndex: +textSeg.endIndex };
}
function rangeStr(documentText: string, seg: SaneSeg) {
  return documentText.slice(+seg.startIndex!, +seg.endIndex!);
}
function rangeFlonk(seg: SaneSeg) {
  return `${seg.startIndex}-${seg.endIndex}`;
}
function getWordsInLine(
  documentText: string,
  textSeg: SaneSeg,
  tokens: docai.Document.Page.IToken[]
) {
  const inxStart = binarySearch(
    tokens,
    textSeg.startIndex,
    (token, s) => getSeg(token).startIndex - s
  );
  const inxEnd = binarySearch(
    tokens,
    textSeg.endIndex,
    (token, s) => getSeg(token).endIndex - s
  );
  const filteredTokens = tokens.slice(Math.abs(inxStart), Math.abs(inxEnd) + 1);
  // console.log(filteredTokens.map((t) => rangeStr(getSeg(t))));
  if (inxStart < 0 || inxEnd < 0) {
    const toktetx = filteredTokens.map((t) =>
      rangeStr(documentText, getSeg(t))
    );
    console.log(inxEnd, tokens.length, rangeFlonk(textSeg));
    throw Error(
      `start or end not found exactly: ${rangeFlonk(
        textSeg
      )} vs first token: ${rangeFlonk(
        getSeg(tokens[Math.abs(inxStart)])
      )} to ${rangeFlonk(getSeg(tokens[Math.abs(inxEnd)]))}: ${rangeStr(
        documentText,
        textSeg
      )} vs. ${JSON.stringify(toktetx)}`
    );
  }
  return filteredTokens;
}

function getBbox(line: docai.Document.Page.ILine, [w, h]: [number, number]) {
  const bbox = line.layout?.boundingPoly?.normalizedVertices;
  if (!bbox) throw Error("no bbox");
  const x = bbox.map((b) => Math.round(w * b.x!));
  const y = bbox.map((b) => Math.round(h * b.y!));
  return {
    xmin: Math.min(...x),
    ymin: Math.min(...y),
    xmax: Math.max(...x),
    ymax: Math.max(...y),
  };
}

function toHOCR(
  imageFileName: string,
  [w, h]: [number, number],
  page: docai.Document.IPage,
  documentText: string
): JSX.Element {
  function getHOCRBbox(line: docai.Document.Page.ILine) {
    const bbox = getBbox(line, [w, h]);
    return `${bbox.xmin} ${bbox.ymin} ${bbox.xmax} ${bbox.ymax}`;
  }

  // todo: ocrp_lang, ocrp_poly, ocrp_nlp

  return (
    <html>
      <head>
        <meta charSet="utf-8" />
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
        {page.lines?.map((line, i) => {
          const bbox = getHOCRBbox(line);
          const textSeg = getSeg(line);
          let curIndex = textSeg.startIndex;
          const words = getWordsInLine(documentText, textSeg, page.tokens!);
          const wordsSpans = words.map((word, i) => {
            const bbox = getHOCRBbox(word);
            const seg = getSeg(word);
            return (
              <span key={i} className="xocr_word" title={`bbox ${bbox}`}>
                {documentText.slice(seg.startIndex, seg.endIndex)}
              </span>
            );
          });
          return (
            <span key={i} className="ocr_line" title={`bbox ${bbox}`}>
              {wordsSpans}
            </span>
          );
          /*let text = documentText.slice(
            +textSeg.startIndex!,
            +textSeg.endIndex!
          );
          if (text[text.length - 1] !== "\n")
            throw Error(
              `expected \\n at end of line, got ${JSON.stringify(text)}`
            );
          text = text.slice(0, -1);
          console.log(text);
          return (
            <span key={i} className="ocr_line" title={`bbox ${bbox}`}>
              {text}
            </span>
          );*/
        })}
      </div>
      <script src="https://unpkg.com/hocrjs" />
    </html>
  );
}

function invisibleFont(): Uint8Array {
  const ttf = Buffer.from(
    `eJzdlk1sG0UUx/+zs3btNEmrUKpCPxikSqRS4jpfFURUagmkEQQoiRXgAl07Y3vL2mvt2ml8APXG
hQPiUEGEVDhWVHyIC1REPSAhBOWA+BCgSoULUqsKcWhVBKjhzfPU+VCi3Flrdn7vzZv33ryZ3TUE
gC6chsTx8fHck1ONd98D0jnS7jn26GPjyMIleZhk9fT0wcHFl1/9GRDPkTxTqHg1dMkzJH9CbbTk
xbWlJfKEdB+Np0pBswi+nH/Nvay92VtfJp4nvEztUJkUHXsdksUOkveXK/X5FNuLD838ICx4dv4N
I1e8+ZqbxwCNP2jyqXoV/fmhy+WW/2SqFsb1pX68SfEpZ/TCrI3aHzcP//jitodvYmvL+6Xcr5mV
vb1ScCzRnPRPfz+LsRSWNasuwRrZlh1sx0E8AriddyzEDfE6EkglFhJDJO5u9fJbFJ0etEMB78D5
4Djm/7kjT0wqhSNURyS+u/2MGJKRu+0ExNkrt1pJti9p2x6b3TBJgmUXuzgnDmI8UWMbkVxeinCw
Mo311/l/v3rF7+01D+OkZYE0PrbsYAu+sSyxU0jLLtIiYzmBrFiwnCT9FcsdOOK8ZHbFleSn0znP
nDCnxbnAnGT9JeYtrP+FOcV8nTlNnsoc3bBAD85adtCNRcsSffjBsoseca/lBE7Q09LiJOm/ttyB
0+IqcwfncJt5q4krO5k7jV7uY+5m7mPebuLKUea7iHvk48w72OYF5rvZT8C8k/WvMN/Dc19j3s02
bzPvZZv3me9j/ox5P9t/xdzPzPVJcc7yGnPL/1+GO1lPVTXM+VNWOTRRg0YRHgrUK5yj1kvaEA1E
xAWiCtl4qJL2ADKkG6Q3XxYjzEcR0E9hCj5KtBd1xCxp6jV5mKP7LJBr1nTRK2h1TvU2w0akCmGl
5lWbBzJqMJsdyaijQaCm/FK5HqspHetoTtMsn4LO0T2mlqcwmlTVOT/28wGhCVKiNANKLiJRlxqB
F603axQznIzRhDSq6EWZ4UUs+xud0VHsh1U1kMlmNwu9kTuFaRqpURU0VS3PVmZ0iE7gct0MG/8+
2fmUvKlfRLYmisd1w8pk1LSu1XUlryM1MNTH9epTftWv+16gIh1oL9abJZyjrfF5a4qccp3oFAcz
Wxxx4DpvlaKKxuytRDzeth5rW4W8qBFesvEX8RFRmLBHoB+TpCmRVCCb1gFCruzHqhhW6+qUF6tC
pL26nlWN2K+W1LhRjxlVGKmRTFYVo7CiJug09E+GJb+QocMCPMWBK1wvEOfRFF2U0klK8CppqqvG
pylRc2Zn+XDQWZIL8iO5KC9S+1RekOex1uOyZGR/w/Hf1lhzqVfFsxE39B/ws7Rm3N3nDrhPuMfc
w3R/aE28KsfY2J+RPNp+j+KaOoCey4h+Dd48b9O5G0v2K7j0AM6s+5WQ/E0wVoK+pA6/3bup7bJf
CMGjwvxTsr74/f/F95m3TH9x8o0/TU//N+7/D/ScVcA=`,
    "base64"
  );
  return zlib.inflateSync(ttf);
}

function polyval([a, b]: readonly [number, number], x: number) {
  return a * x + b;
}
function pixelToDots(pixels: number, dpi: number): number {
  return (pixels / dpi) * 72;
}
async function toPDF(
  imageFileName: string,
  [w, h]: [number, number],
  page: docai.Document.IPage,
  documentText: string
) {
  const visibleText = false;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const dpi = 300; // todo: read dpi from image
  const dots = (p: number) => pixelToDots(p, dpi);
  const wdots = dots(w);
  const hdots = dots(h);
  const p = doc.addPage([pixelToDots(w, dpi), pixelToDots(h, dpi)]);
  p.drawImage(await doc.embedJpg(await fs.readFile(imageFileName)), {
    width: pixelToDots(w, dpi),
    height: pixelToDots(h, dpi),
    opacity: 0.3,
  });
  const font = await doc.embedFont(
    visibleText ? StandardFonts.Helvetica : invisibleFont()
  );

  for (const line of page.lines!) {
    const linebox = getBbox(line, [w, h]);
    //try:
    //    baseline = p2.search(line.attrib["title"]).group(1).split()
    //except AttributeError:
    const baseline = [0, 0] as const;
    const words = getWordsInLine(documentText, getSeg(line), page.tokens!);
    for (const word of words) {
      const rawtext = rangeStr(documentText, getSeg(word)).trim();
      const fontWidth = font.widthOfTextAtSize(rawtext, 8);
      // if font_width <= 0:
      //    continue
      const box = getBbox(word, [w, h]);
      const b =
        polyval(baseline, (box.xmin + box.xmax) / 2 - linebox.xmin) +
        linebox.ymax;
      console.log(
        `text=${rawtext}, fontWidth=${fontWidth}, boxWidth=${dots(
          box.xmax - box.xmin
        )}`
      );
      p.drawRectangle({
        x: dots(box.xmin),
        y: dots(h - box.ymin),
        borderColor: rgb(1, 0, 0),
        // color: null,
        borderWidth: 1,
        width: dots(box.xmax - box.xmin),
        height: dots(-(box.ymax - box.ymin)),
      });

      const boxWidth = dots(box.xmax - box.xmin);
      p.pushOperators(
        /*setTextRenderingMode(
          visibleText ? TextRenderingMode.Fill : TextRenderingMode.Invisible
        )*/

        // SetTextHorizontalScaling
        setCharacterSqueeze((100.0 * boxWidth) / fontWidth)
      );
      p.drawText(rawtext, {
        x: dots(box.xmin),
        y: dots(h - b),
        size: 8,
        color: rgb(0, 0, 0),
      });
    }
  }
  return doc;
}
async function main(imageFilePath: string) {
  const jsonFilePath = imageFilePath + ".docai.json";
  const txtFilePath = imageFilePath + ".ocr.txt";
  const pdfFilePath = imageFilePath + ".ocr.pdf";
  const hocrFilePath = imageFilePath + ".hocr";
  let ocr: docai.IProcessResponse;
  try {
    ocr = JSON.parse(await fs.readFile(jsonFilePath, "utf8"));
  } catch (e) {
    if (!e || typeof e !== "object" || !("code" in e) || e.code !== "ENOENT")
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
  const page = ocr.document.pages[0];
  if (!page.lines) throw Error("no lines");
  assertArraySorted(page.lines, (line) => getSeg(line).startIndex);
  assertArraySorted(
    page.tokens!,
    (t) => +t.layout?.textAnchor?.textSegments?.[0].startIndex!
  );
  const width = page.image?.width;
  const height = page.image?.height;
  if (!width || !height) throw Error("no width or height");
  const writeHocr = false;
  if (writeHocr) {
    const hocr = toHOCR(
      basename(imageFilePath),
      [width, height],
      page,
      ocr.document.text
    );
    const hocrString = "<!DOCTYPE html>\n" + renderToStaticMarkup(hocr);
    await fs.writeFile(hocrFilePath, hocrString, { flag: "w" });
    console.log(`wrote hocr to ${hocrFilePath}`);
  }
  {
    const pdf = await toPDF(
      imageFilePath,
      [width, height],
      page,
      ocr.document.text
    );
    const bytes = await pdf.save();
    await fs.writeFile(pdfFilePath, bytes, { flag: "w" });
    console.log(`wrote pdf to ${pdfFilePath}`);
  }
}

const args = process.argv.slice(2) as [string];
main(...args).catch((err) => {
  console.error(err);
  process.exit(1);
});
