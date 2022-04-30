import * as fs from "fs/promises";

async function main(projectId: string, location: string, processorId: string, filePath: string) {
  // [START documentai_process_ocr_document]
  /**
   * TODO(developer): Uncomment these variables before running the sample.
   */
  // const projectId = 'YOUR_PROJECT_ID';
  // const location = 'YOUR_PROJECT_LOCATION'; // Format is 'us' or 'eu'
  // const processorId = 'YOUR_PROCESSOR_ID'; // Create processor in Cloud Console
  // const filePath = '/path/to/local/pdf';

  const { DocumentProcessorServiceClient } =
    require("@google-cloud/documentai").v1beta3;

  // Instantiates a client
  const client = new DocumentProcessorServiceClient();

  // The full resource name of the processor, e.g.:
  // projects/project-id/locations/location/processor/processor-id
  // You must create new processors in the Cloud Console first
  const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;

  // Read the file into memory.
  const imageFile = await fs.readFile(filePath);

  // Convert the image data to a Buffer and base64 encode it.
  const encodedImage = Buffer.from(imageFile).toString("base64");

  const request = {
    name,
    rawDocument: {
      content: encodedImage,
      mimeType: "application/pdf",
    },
  };

  // Recognizes text entities in the PDF document
  const [result] = await client.processDocument(request);
}



main(...(process.argv.slice(2) as any)).catch(err => {
    console.error(err);
    process.exitCode = 1;
  });