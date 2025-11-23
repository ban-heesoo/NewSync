// ==================================================================================================
// EXTERNAL SERVICE - GOOGLE
// ==================================================================================================

import { Utilities } from '../utils/utilities.js';
import { CONFIG } from '../constants.js';

export class GoogleService {
  static async translate(text, targetLang) {
    if (!text.trim()) return "";
    
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
    
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google Translate error: ${response.statusText}`);
    
    const data = await response.json();
    return data?.[0]?.map(segment => segment?.[0]).join('') || text;
  }

  static async romanize(originalLyrics) {
    if (originalLyrics.type === "Word") {
      return this.romanizeWordSynced(originalLyrics);
    } else {
      return this.romanizeLineSynced(originalLyrics);
    }
  }

  static async romanizeWordSynced(originalLyrics) {
    return Promise.all(originalLyrics.data.map(async (line) => {
      if (!line.syllabus?.length) return line;
      
      const syllableTexts = line.syllabus.map(s => s.text);
      let romanizedTexts;
      try {
        romanizedTexts = await this.romanizeTexts(syllableTexts);
      } catch (error) {
        console.error("GoogleService: Failed to romanize syllables for line:", error);
        throw error;
      }
      
      const newSyllabus = line.syllabus.map((s, index) => ({
        ...s,
        romanizedText: romanizedTexts[index] ? `${romanizedTexts[index]} ` : s.text
      }));
      
      return { ...line, syllabus: newSyllabus };
    }));
  }

  static async romanizeLineSynced(originalLyrics) {
    const linesToRomanize = originalLyrics.data.map(line => line.text);
    let romanizedLines;
    try {
      romanizedLines = await this.romanizeTexts(linesToRomanize);
    } catch (error) {
      console.error("GoogleService: Failed to romanize lines:", error);
      throw error;
    }
    
    return originalLyrics.data.map((line, index) => ({
      ...line,
      romanizedText: romanizedLines[index] || line.text
    }));
  }

  static async romanizeTexts(texts) {
    const contextText = texts.join(' ');
    
    if (Utilities.isPurelyLatinScript(contextText)) {
      return texts;
    }

    let sourceLang = 'auto';
    try {
      const detectUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(contextText)}`;
      const detectResponse = await fetch(detectUrl);
      
      if (detectResponse.ok) {
        const detectData = await detectResponse.json();
        sourceLang = detectData[2] || 'auto';
      }
    } catch (e) {
      console.error("GoogleService: Language detection failed, using 'auto':", e);
    }

    const romanizedTexts = [];
    for (const text of texts) {
      if (Utilities.isPurelyLatinScript(text)) {
        romanizedTexts.push(text);
        continue;
      }
      
      let attempt = 0;
      let success = false;
      let lastError = null;

      while (attempt < CONFIG.GOOGLE.MAX_RETRIES && !success) {
        try {
          const romanizeUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=en&hl=en&dt=rm&q=${encodeURIComponent(text)}`;
          const response = await fetch(romanizeUrl);
          
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
          
          const data = await response.json();
          const romanized = data?.[0]?.[0]?.[3];
          
          // Check if we got a valid romanization (not empty and different from input for non-Latin)
          if (romanized && romanized.trim()) {
            // For non-Latin scripts, check if result is actually different from input
            if (Utilities.isPurelyLatinScript(text)) {
              romanizedTexts.push(romanized);
              success = true;
            } else if (romanized.trim() !== text.trim()) {
              // Valid romanization for non-Latin script
              romanizedTexts.push(romanized);
              success = true;
            } else {
              // Result same as input for non-Latin script - consider it failed
              throw new Error("Google returned same text as input (romanization failed)");
            }
          } else {
            // Empty result - consider it failed for non-Latin scripts
            if (Utilities.isPurelyLatinScript(text)) {
              romanizedTexts.push(text);
              success = true;
            } else {
              throw new Error("Google returned empty romanization");
            }
          }
        } catch (error) {
          lastError = error;
          console.warn(`GoogleService: Error romanizing text "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" (attempt ${attempt + 1}/${CONFIG.GOOGLE.MAX_RETRIES}):`, error);
          attempt++;
          if (attempt < CONFIG.GOOGLE.MAX_RETRIES) {
            await Utilities.delay(CONFIG.GOOGLE.RETRY_DELAY_MS * Math.pow(2, attempt - 1));
          }
        }
      }

      if (!success) {
        console.error(`GoogleService: Failed to romanize text "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" after ${CONFIG.GOOGLE.MAX_RETRIES} attempts. Last error:`, lastError);
        // Throw error to trigger fallback to Gemini
        throw new Error(`Google romanization failed after ${CONFIG.GOOGLE.MAX_RETRIES} attempts: ${lastError?.message || lastError}`);
      }
    }
    
    return romanizedTexts;
  }
}

