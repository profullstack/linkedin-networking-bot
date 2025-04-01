import OpenAI from 'openai';

let openaiClient = null;

/**
 * Initialize OpenAI client with API key
 * @param {string} apiKey - OpenAI API key
 */
export function initOpenAI(apiKey) {
  openaiClient = new OpenAI({
    apiKey: apiKey
  });
}

/**
 * Analyze puzzle captcha image using OpenAI Vision API
 * @param {string} base64Image - Base64 encoded image data
 * @returns {Promise<string>} Description of the puzzle solution
 */
export async function analyzePuzzleCaptcha(base64Image) {
  if (!openaiClient) {
    throw new Error('OpenAI client not initialized');
  }

  try {
    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Analyze this LinkedIn puzzle captcha. Identify which way is up and provide the exact coordinates (x,y) where I should click to rotate the puzzle piece to its correct orientation. The coordinates should be relative to the puzzle element's top-left corner (0,0). Return the response in this exact format: {\"orientation\": \"degrees_to_rotate\", \"click_coordinates\": {\"x\": number, \"y\": number}}"
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`
              }
            }
          ]
        }
      ],
      max_tokens: 100
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error analyzing puzzle captcha:', error);
    throw error;
  }
}

/**
 * Analyze captcha box and click on produce coordinates to click on Verify Now button
 */
export async function analyzeCaptchaBox(base64Image, prompt) {
  if (!openaiClient) {
    throw new Error('OpenAI client not initialized');
  }

  try {
    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analyze this page. ${prompt} and provide the exact coordinates (x,y) where I should click. The coordinates should be relative to the button element's top-left corner (0,0). Return the response in this exact format: {\"orientation\": \"degrees_to_rotate\", \"click_coordinates\": {\"x\": number, \"y\": number}}`
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`
              }
            }
          ]
        }
      ],
      max_tokens: 100
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error analyzing puzzle captcha:', error);
    throw error;
  }
}