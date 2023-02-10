import * as ai from "@google-cloud/documentai";
import { ZstdInit } from "@oneidentity/zstd-js";
import fontkit from "@pdf-lib/fontkit";
import binarySearch from "binary-search";
import * as math from "mathjs";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import { basename } from "node:path";
import * as process from "node:process";
import * as o from "pdf-lib";
import {
  PDFDocument,
  rgb,
  setCharacterSqueeze,
  setTextRenderingMode,
  TextRenderingMode,
} from "pdf-lib";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExifParserFactory } from "ts-exif-parser";
import * as zlib from "zlib";
import docai = ai.protos.google.cloud.documentai.v1;

type DocAiResp = docai.IProcessResponse & {
  requestMeta: { apiEndpoint: string; processorName: string };
};
async function runOCR(imageFilePath: string): Promise<DocAiResp> {
  const { DocumentProcessorServiceClient } = ai.v1;
  const apiEndpoint = process.env.API_ENDPOINT;
  if (!apiEndpoint) throw Error("no API_ENDPOINT");

  // The full resource name of the processor, e.g.:
  // projects/project-id/locations/location/processor/processor-id
  // You must create new processors in the Cloud Console first
  const processorName = process.env.PROCESSOR_NAME;
  if (!processorName) throw Error("no PROCESSOR_NAME");

  // Instantiates a client
  const client = new DocumentProcessorServiceClient({
    apiEndpoint,
  });

  // Read the file into memory.
  const imageFile = await fs.readFile(imageFilePath);

  // Convert the image data to a Buffer and base64 encode it.
  const encodedImage = Buffer.from(imageFile).toString("base64");

  const request = {
    name: processorName,
    rawDocument: {
      content: encodedImage,
      mimeType: "image/jpeg",
    },
  };

  // Recognizes text entities in the PDF document
  const [result] = await client.processDocument(request);
  if (result.document && result.document.pages) {
    for (const page of result.document.pages) {
      if (page.image?.content) {
        await fs.writeFile(
          `/tmp/page-${page.pageNumber}.jpg`,
          page.image.content
        );
        delete page.image.content;
      }
    }
  }
  return { ...result, requestMeta: { apiEndpoint, processorName } };
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
async function visibleFont() {
  return await fs.readFile(__dirname + "/data/NotoSans-Regular.ttf"); // StandardFonts.Helvetica;
}
import Orientation = docai.Document.Page.Layout.Orientation;

/*function transform(
  matrix: Float64Array,
  vec: [number, number]
): [number, number] {
  const [A00, A01, A02, A10, A11, A12] = matrix;
  const [x0, x1] = vec;
  const x2 = 1;
  return [A00 * x0 + A01 * x1 + A02 * x2, A10 * x0 + A11 * x1 + A12 * x2];
}*/
function transform(
  matrix: math.Matrix,
  [x, y]: [number, number]
): [number, number] {
  const res = math.multiply(matrix, [x, y, 1]);
  return [res.get([0]), res.get([1])];
}

function imageRotated(
  [wpix, hpix]: [number, number],
  transforms: docai.Document.Page.IMatrix[]
) {
  // orientation: keyof typeof Orientation
  if (transforms.length === 0) {
    return { x: 0, y: hpix, rotate: o.degrees(0) };
  }
  if (transforms.length !== 1) throw Error("not exactly one transform");
  const imatrix = transforms[0];
  // https://docs.opencv.org/4.3.0/d1/d1b/group__core__hal__interface.html#ga30a562691cc5987bc88eb7bb7a8faf2b
  if (imatrix.type !== 6) throw Error("not a f64 matrix");
  if (imatrix.cols !== 3 || imatrix.rows !== 2)
    throw Error("matrix wrong size");
  if (!(imatrix.data instanceof Buffer)) {
    const d = imatrix.data as any as { type: "Buffer"; data: number[] };
    imatrix.data = Buffer.from(d.data);
    // throw Error(`not buffer, ${matrix.data}`);
  }
  const matrixarr = Array.from(
    new Float64Array(
      imatrix.data.buffer,
      imatrix.data.byteOffset,
      imatrix.data.byteLength / 8
    )
  );
  const matrix = math.matrix([
    matrixarr.slice(0, 3),
    matrixarr.slice(3, 6),
    [0, 0, 1],
  ]);
  // console.log(imatrix, "matrix:", matrix);
  // console.log([0, 0], "->", transform(matrix, [0, 0]));
  // console.log([wpix, hpix], "->", transform(matrix, [wpix, hpix]));
  // console.log([0, hpix], "->", transform(matrix, [0, hpix]));
  // transform the lower left corner
  const [x, y] = transform(matrix, [0, hpix]);
  // https://math.stackexchange.com/a/13165
  const rot = -Math.atan2(-matrix.get([0, 1]), matrix.get([0, 0]));
  // console.log("rotation:", o.radiansToDegrees(rot), "°");
  return {
    x,
    y,
    width: wpix,
    height: hpix,
    rotate: o.radians(rot),
  };
  /*switch (orientation) {
    case "PAGE_UP":
      x = 0;
      y = 0;
      break;
    case "PAGE_RIGHT":
      throw Error("cannot right");
    case "PAGE_DOWN":
      throw Error("cannot down");
    case "PAGE_LEFT":
      throw Error("cannot left");
    default:
      throw Error("unknown orientation");
  }*/
}
type Config = {
  debugDraw: boolean;
  writeTxt: boolean;
  writeHocr: boolean;
  writePdf: boolean;
};
async function toPDF(
  imageFileName: string,
  [wpix, hpix]: [number, number],
  page: docai.Document.IPage,
  documentText: string,
  config: Config
) {
  const visibleText = config.debugDraw;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const jpgFile = await fs.readFile(imageFileName);
  const exifInfo = ExifParserFactory.create(jpgFile).parse();
  const { width: origwpix, height: orighpix } = exifInfo.getImageSize();
  const dpi = exifInfo.tags?.XResolution ?? 300;
  const ydpi = exifInfo.tags?.YResolution ?? 300;
  if (ydpi !== 300) throw Error(`dpi not square: ${dpi}`);
  const dots = (p: number) => pixelToDots(p, dpi);
  const wdots = dots(wpix);
  const hdots = dots(hpix);
  const p = doc.addPage([wdots, hdots]);
  const trafo = imageRotated([origwpix, orighpix], page.transforms!);
  p.drawImage(await doc.embedJpg(jpgFile), {
    opacity: config.debugDraw ? 0.3 : 1,
    x: dots(trafo.x),
    y: hdots - dots(trafo.y),
    width: dots(origwpix),
    height: dots(orighpix),
    rotate: trafo.rotate,
  });
  const font = await doc.embedFont(
    visibleText ? await visibleFont() : invisibleFont()
  );

  for (const line of page.lines!) {
    const linebox = getBbox(line, [wdots, hdots]);
    //try:
    //    baseline = p2.search(line.attrib["title"]).group(1).split()
    //except AttributeError:
    const baseline = [0, 0] as const;
    const words = getWordsInLine(documentText, getSeg(line), page.tokens!);
    let i = 0;
    for (const word of words) {
      let rawtext = rangeStr(documentText, getSeg(word));
      if (i === words.length - 1) {
        if (rawtext[rawtext.length - 1] !== "\n")
          throw Error("last word in line should end with \\n");
        rawtext = rawtext.slice(0, -1);
      }
      const box = getBbox(word, [wdots, hdots]);

      const baselineEstimate = ((box.ymax - box.ymin) * 1) / 4; // baseline at 1/4 of height from bottom
      /*p.drawRectangle({
        x: box.xmin,
        y: hdots - box.ymin,
        borderColor: rgb(1, 0, 0),
        opacity: 0.5,
        // color: null,
        borderWidth: 1,
        width: box.xmax - box.xmin,
        height: -(box.ymax - box.ymin),
      });*/
      const boundingPoly = word.layout?.boundingPoly?.normalizedVertices;
      if (!boundingPoly) throw Error("no verts");
      let angle;
      let textLengthDots;
      let textHeightDots;
      {
        // word angle and length calc
        const [_tl, _tr, _br, _bl] = boundingPoly;
        const sizedots = math.matrix([wdots, hdots]);
        const tl = math.dotMultiply(math.matrix([_tl.x!, _tl.y!]), sizedots);
        const tr = math.dotMultiply(math.matrix([_tr.x!, _tr.y!]), sizedots);
        const bl = math.dotMultiply(math.matrix([_bl.x!, _bl.y!]), sizedots);
        const br = math.dotMultiply(math.matrix([_br.x!, _br.y!]), sizedots);
        const l = math.multiply(math.add(tl, bl), 0.5);
        const r = math.multiply(math.add(tr, br), 0.5);
        const dir = math.subtract(r, l);
        angle = math.atan2(dir.get([0]), dir.get([1])) - Math.PI / 2;
        textLengthDots = +math.norm(dir);
        textHeightDots = +math.norm(
          math.subtract(
            math.multiply(math.add(tl, tr), 0.5),
            math.multiply(math.add(bl, br), 0.5)
          )
        );

        console.log(o.radiansToDegrees(angle));
      }
      const fontSize = font.sizeAtHeight(textHeightDots);
      // trim since words end with space but box doesn't include the trailing space
      const fontWidth = font.widthOfTextAtSize(rawtext.trim(), fontSize);

      if (config.debugDraw) {
        const ncolor = o.setStrokingColor(rgb(0, 1, 0));

        const ops = [
          o.pushGraphicsState(),
          ncolor,
          o.setLineWidth(1),
          ...boundingPoly.map((n, i) =>
            (i === 0 ? o.moveTo : o.lineTo)(n.x! * wdots, hdots - n.y! * hdots)
          ),
          o.closePath(),
          o.stroke(),
          o.popGraphicsState(),
        ];
        p.pushOperators(...ops);
      }
      const boxWidth = textLengthDots;
      //const boxWidth = box.xmax - box.xmin;
      p.pushOperators(
        setTextRenderingMode(
          visibleText ? TextRenderingMode.Fill : TextRenderingMode.Invisible
        ),

        // SetTextHorizontalScaling
        setCharacterSqueeze((100.0 * boxWidth) / fontWidth)
      );
      p.drawText(rawtext, {
        x: boundingPoly[3].x! * wdots, //box.xmin,
        y: hdots - boundingPoly[3].y! * hdots, // + baselineEstimate,
        font,
        size: fontSize,
        color: rgb(0, 0, 0),
        rotate: o.radians(angle),
      });
      i++;
    }
  }
  return doc;
}
async function main(imageFilePath: string) {
  const config: Config = {
    writeTxt: true,
    writePdf: true,
    writeHocr: false,
    debugDraw: false,
  };
  const jsonFilePath = imageFilePath + ".docai.json.zst";
  const txtFilePath = imageFilePath + ".ocr.txt";
  const pdfFilePath = imageFilePath + ".ocr.pdf";
  const hocrFilePath = imageFilePath + ".hocr";
  let ocr: docai.IProcessResponse;
  const { ZstdSimple } = await ZstdInit();
  try {
    ocr = JSON.parse(
      new TextDecoder().decode(
        ZstdSimple.decompress(await fs.readFile(jsonFilePath))
      )
    );
  } catch (e) {
    if (!e || typeof e !== "object" || !("code" in e) || e.code !== "ENOENT")
      throw e;
    ocr = await runOCR(imageFilePath);
    const jsonCompressed = ZstdSimple.compress(
      new TextEncoder().encode(JSON.stringify(ocr, null, 2)),
      19
    );
    await fs.writeFile(jsonFilePath, jsonCompressed, {
      flag: "wx",
    });
    if (config.writeTxt && ocr.document?.text) {
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
  if (config.writeHocr) {
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
  if (config.writePdf) {
    const pdf = await toPDF(
      imageFilePath,
      [width, height],
      page,
      ocr.document.text,
      config
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
