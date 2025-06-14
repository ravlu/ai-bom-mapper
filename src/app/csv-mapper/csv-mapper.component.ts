// src/app/csv-mapper/csv-mapper.component.ts
import { Component, OnInit, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { environment } from '../../environments/environment';

// Predefined example values for potential SMAT columns.
const smat_columns_values: Record<string, string[]> = {
    // Example:
    // "Status": ["Open", "Closed", "Pending"],
    // "Priority": ["High", "Medium", "Low"]
};

interface MappingTableRow {
    sourceHeader: string;
    selectedTarget: string;
    aiSuggestedTargetValue?: string; // The value AI suggested (could be N_A or a column name)
    aiSuggestionType?: 'header' | 'value' | 'triplet' | null;
    isAiSuggestedTemporarily?: boolean; // For temporary class on row/select
    isDuplicate?: boolean;
    // aiSuggestedOptionValue?: string; // The value of the option that AI suggested (for persistent option highlight)
}

@Component({
  selector: 'app-csv-mapper',
  templateUrl: './csv-mapper.component.html',
  styleUrls: ['./csv-mapper.component.css']
})
export class CsvMapperComponent implements OnInit, OnDestroy {
  private odataUrl = 'https://684c168eed2578be881d9c58.mockapi.io/api/v1/LineItemProperties';
  sourceCsvHeaders: string[] = [];
  sourceCsvSampleData: string[][] = []; // Only first 10 rows of actual data
  targetSchemaColumns: string[] = [];
  tripletKnowledgeBase: Array<{ anchor: string, positive: string, negative: string }> = [];

  isSourceUploaded = false;
  isTargetSchemaProvided = false; // This will be set by OData fetch
  isTripletKnowledgeBaseUploaded = false;

  readonly N_A_MAP_VALUE = "__N/A_MAPPING__";

  statusMessageText = 'Please upload a Source CSV and a Target Schema CSV to begin.';
  isStatusError = false;

  mappingTableRows: MappingTableRow[] = [];

  // Button states & UI
  suggestMappingsButtonDisabled = true;
  downloadTripletCsvButtonVisible = false;
  downloadTripletCsvButtonDisabled = true;
  downloadMappedDataButtonVisible = false;
  downloadMappedDataButtonDisabled = true;
  aiSuggestionControlsVisible = false;

  isSuggesting = false;
  suggestButtonText = 'Suggest Mappings with AI';
  private suggestionTimeouts: any[] = []; // To clear timeouts on component destroy

  private genAI: GoogleGenAI | null = null;

  constructor(private cdr: ChangeDetectorRef, private http: HttpClient) {
    if (!environment.apiKey) {
      console.error("API_KEY environment variable not set for Gemini API.");
      this.updateStatus('Configuration error: API Key is missing. Cannot contact AI service.', true);
    } else {
      this.genAI = new GoogleGenAI({apiKey: environment.apiKey});
      
    }
  }

  ngOnInit(): void {
    this.fetchTargetSchemaFromOData(); // Load target schema on init
    this.checkIfReadyForMappingAndSuggestions();
  }

  ngOnDestroy(): void {
    this.suggestionTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
  }

  handleLabelKeyDown(event: KeyboardEvent, inputElement: HTMLInputElement): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      inputElement.click();
    }
  }

  getOptionClass(optionValue: string, row: MappingTableRow): any {
    const classes: any = {};
    const isSuggestedOption = optionValue === row.aiSuggestedTargetValue;

    if (isSuggestedOption) {
        if (row.aiSuggestionType === 'header' || row.aiSuggestionType === 'triplet') {
            classes['ai-suggested-option-header'] = true;
        } else if (row.aiSuggestionType === 'value') {
            classes['ai-suggested-option-value'] = true;
        }
    }
    return classes;
  }


  updateStatus(message: string, isError: boolean): void {
    this.statusMessageText = message;
    this.isStatusError = isError;
    this.cdr.detectChanges(); // Inform Angular of changes
  }

  clearMappingTable(): void {
    this.mappingTableRows = [];
    this.updateDownloadButtonsState();
    this.cdr.detectChanges();
  }

  getSelectedTargetMappings(): Record<string, string> {
    const mappings: Record<string, string> = {};
    this.mappingTableRows.forEach(row => {
      mappings[row.sourceHeader] = row.selectedTarget;
    });
    return mappings;
  }

  checkAndHighlightDuplicateTargets(): boolean {
    if (!this.mappingTableRows || this.mappingTableRows.length === 0) return false;

    const targetCounts: Record<string, number> = {};
    this.mappingTableRows.forEach(row => {
      row.isDuplicate = false; // Reset first
      const value = row.selectedTarget;
      if (value && value !== this.N_A_MAP_VALUE && value !== "") {
        targetCounts[value] = (targetCounts[value] || 0) + 1;
      }
    });

    let duplicatesWereFoundThisCheck = false;
    this.mappingTableRows.forEach(row => {
      const value = row.selectedTarget;
      if (value && value !== this.N_A_MAP_VALUE && value !== "" && targetCounts[value] > 1) {
        row.isDuplicate = true;
        duplicatesWereFoundThisCheck = true;
      }
    });

    const duplicateErrorMessage = "Validation Error: One or more target columns are selected multiple times. Please resolve.";
    if (duplicatesWereFoundThisCheck) {
      this.updateStatus(duplicateErrorMessage, true);
    } else {
      if (this.statusMessageText === duplicateErrorMessage) {
        this.updateStatus('Duplicate target selections resolved.', false);
      }
    }
    this.cdr.detectChanges();
    return duplicatesWereFoundThisCheck;
  }

  async fetchTargetSchemaFromOData(): Promise<void> {
    this.updateStatus('Fetching target schema from OData...', false);
    try {
      const response = await this.http.get<Array<{ DisplayName: string }>>(this.odataUrl).toPromise();
      if (response && Array.isArray(response)) {
        this.targetSchemaColumns = response.map(item => item.DisplayName).filter(name => name);
        if (this.targetSchemaColumns.length > 0) {
          this.isTargetSchemaProvided = true;
          this.updateStatus(`Target schema loaded from OData: ${this.targetSchemaColumns.length} columns.`, false);
        } else {
          this.updateStatus('Target schema loaded from OData, but no display names found.', true);
          this.isTargetSchemaProvided = false;
        }
      } else {
        this.updateStatus('Error: Invalid response structure from OData for target schema.', true);
        this.isTargetSchemaProvided = false;
      }
    } catch (error) {
      console.error('Error fetching target schema from OData:', error);
      this.updateStatus('Error fetching target schema from OData. Check console for details.', true);
      this.isTargetSchemaProvided = false;
    }
    this.checkIfReadyForMappingAndSuggestions(); // Update UI based on new state
  }

  updateDownloadButtonsState(): void {
    // Triplet Data Button
    if (this.isSourceUploaded && this.isTargetSchemaProvided) {
      this.downloadTripletCsvButtonVisible = true;
      this.downloadTripletCsvButtonDisabled = false; // Enable if suggestions were made
    } else {
      this.downloadTripletCsvButtonVisible = false;
      this.downloadTripletCsvButtonDisabled = true;
    }

    // Mapped Data Button
    let hasValidMapping = false;
    if (this.isSourceUploaded) {
      const currentMappings = this.getSelectedTargetMappings();
      hasValidMapping = Object.values(currentMappings).some(target => target && target !== this.N_A_MAP_VALUE && target !== "");
    }

    if (this.isSourceUploaded && hasValidMapping) {
      this.downloadMappedDataButtonVisible = true;
      this.downloadMappedDataButtonDisabled = false;
    } else {
      this.downloadMappedDataButtonVisible = false;
      this.downloadMappedDataButtonDisabled = true;
    }
    this.cdr.detectChanges();
  }

  checkIfReadyForMappingAndSuggestions(): void {
    if (this.isSourceUploaded && this.isTargetSchemaProvided) {
      this.aiSuggestionControlsVisible = true;
      this.suggestMappingsButtonDisabled = false;
      let readyMessage = 'Source CSV loaded. Target Schema automatically loaded from OData.';
      if (this.isTripletKnowledgeBaseUploaded) {
        readyMessage += ' Triplet Knowledge CSV also loaded.';
      }
      readyMessage += ' You can now manually map columns or use AI suggestions.';
      this.updateStatus(readyMessage, false);

      if (this.sourceCsvHeaders.length > 0 && this.mappingTableRows.length === 0) { // Avoid re-creating table if already exists
        this.displayMappingTable(this.sourceCsvHeaders);
      }
    } else {
      this.aiSuggestionControlsVisible = false;
      this.suggestMappingsButtonDisabled = true;
      if (this.isSourceUploaded && !this.isTargetSchemaProvided) {
        // This case might be transient while OData is fetching
        this.updateStatus('Source CSV loaded. Waiting for Target Schema from OData...', false);
        if (this.sourceCsvHeaders.length > 0 && this.mappingTableRows.length === 0) this.displayMappingTable(this.sourceCsvHeaders);
      } else if (!this.isSourceUploaded && this.isTargetSchemaProvided) {
        // This case should be less common now, but possible if OData loads before source
        this.updateStatus('Target Schema loaded from OData. Please upload the Source CSV.', false);
        this.clearMappingTable();
      } else if (!this.isSourceUploaded && !this.isTargetSchemaProvided) {
        this.updateStatus('Please upload a Source CSV to begin. Target schema will be loaded automatically from OData.', false);
        this.clearMappingTable();
      }
    }
    this.checkAndHighlightDuplicateTargets();
    this.updateDownloadButtonsState();
    this.cdr.detectChanges();
  }

  handleFileUpload(event: Event, type: 'source' | 'target' | 'triplet'): void {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];

    // Target type is no longer handled by file upload
    if (type === 'target') {
        console.warn('handleFileUpload called with type "target", which is deprecated.');
        return;
    }

    if (!file) {
      this.updateStatus(`No file selected for ${type}.`, true);
      if (type === 'source') {
        this.clearMappingTable();
        this.isSourceUploaded = false;
        this.sourceCsvHeaders = [];
        this.sourceCsvSampleData = [];
      } else if (type === 'triplet') {
        this.isTripletKnowledgeBaseUploaded = false;
        this.tripletKnowledgeBase = [];
      }
      this.checkIfReadyForMappingAndSuggestions();
      target.value = ''; // Clear file input
      return;
    }

    if (file.type !== 'text/csv' && !file.name.toLowerCase().endsWith('.csv')) {
      this.updateStatus(`Invalid file type for ${type}. Please upload a .csv file.`, true);
      if (type === 'source') { this.clearMappingTable(); this.isSourceUploaded = false; }
      else if (type === 'triplet') { this.isTripletKnowledgeBaseUploaded = false; this.tripletKnowledgeBase = []; }
      target.value = '';
      this.checkIfReadyForMappingAndSuggestions();
      return;
    }

    this.updateStatus(`Processing ${type} CSV...`, false);
    const reader = new FileReader();

    reader.onload = (e: ProgressEvent<FileReader>) => {
      const content = e.target?.result as string;
      if (!content) {
        this.updateStatus(`Error: Could not read ${type} file content.`, true);
        // Reset states
        target.value = '';
        this.checkIfReadyForMappingAndSuggestions();
        return;
      }

      const lines = content.split(/\r\n|\n/).filter(line => line.trim() !== "");
      if (lines.length === 0) {
        this.updateStatus(`Error: ${type} CSV file is empty.`, true);
        // Reset states
        target.value = '';
        this.checkIfReadyForMappingAndSuggestions();
        return;
      }

      const rawHeaders = lines[0].split(',').map(header => header.trim().replace(/^"|"$/g, ''));

      if (type === 'triplet') {
        const requiredTripletHeaders = ['anchor', 'positive', 'negative'];
        const lowerCaseRawHeaders = rawHeaders.map(h => h.toLowerCase());
        const missingHeaders = requiredTripletHeaders.filter(rh => !lowerCaseRawHeaders.includes(rh));

        if (missingHeaders.length > 0) {
          this.updateStatus(`Error: Triplet CSV missing required headers: ${missingHeaders.join(', ')}. Headers must be 'anchor', 'positive', 'negative'.`, true);
          this.isTripletKnowledgeBaseUploaded = false;
          this.tripletKnowledgeBase = [];
          target.value = '';
        } else {
          this.tripletKnowledgeBase = lines.slice(1).map(line => {
            const values = line.split(',').map(cell => cell.trim().replace(/^"|"$/g, ''));
            const anchorIndex = lowerCaseRawHeaders.indexOf('anchor');
            const positiveIndex = lowerCaseRawHeaders.indexOf('positive');
            const negativeIndex = lowerCaseRawHeaders.indexOf('negative');
            return {
              anchor: values[anchorIndex] || "",
              positive: values[positiveIndex] || "",
              negative: values[negativeIndex] || ""
            };
          }).filter(entry => entry.anchor);
          this.isTripletKnowledgeBaseUploaded = true;
          this.updateStatus(`Triplet Knowledge CSV: Loaded ${this.tripletKnowledgeBase.length} entries.`, false);
        }
      } else {
        const headers = rawHeaders.filter(header => header !== "");
        if (headers.length === 0) {
          this.updateStatus(`Error: No valid column headers found in the ${type} CSV file.`, true);
          // Reset relevant state
          target.value = '';
        } else {
          if (type === 'source') {
            this.sourceCsvHeaders = headers;
            const sampleDataLines = lines.slice(1, 11);
            this.sourceCsvSampleData = sampleDataLines
              .map(line => line.split(',').map(cell => cell.trim().replace(/^"|"$/g, '')))
              .filter(row => row.length === headers.length && row.some(cell => cell !== ""));
            this.isSourceUploaded = true;
            this.updateStatus(`Source CSV: Loaded ${headers.length} columns and ${this.sourceCsvSampleData.length} sample data rows.`, false);
          }
          // 'target' type is no longer processed here
        }
      }
      this.checkIfReadyForMappingAndSuggestions();
    };

    reader.onerror = () => {
      this.updateStatus(`Error reading ${type} file.`, true);
       target.value = '';
      this.checkIfReadyForMappingAndSuggestions();
    };
    reader.readAsText(file);
  }

  displayMappingTable(headers: string[]): void {
    this.clearMappingTable(); // Clears this.mappingTableRows

    this.mappingTableRows = headers.map(header => ({
      sourceHeader: header,
      selectedTarget: "", // Default empty selection
      isDuplicate: false,
      isAiSuggestedTemporarily: false,
      aiSuggestionType: null,
      aiSuggestedTargetValue: undefined,
    }));
    this.checkAndHighlightDuplicateTargets();
    this.updateDownloadButtonsState();
    this.cdr.detectChanges();
  }

  onMappingChange(changedRow: MappingTableRow): void {
    changedRow.isAiSuggestedTemporarily = false; // User manually changed it
    // changedRow.aiSuggestionType = null; // Keep type for persistent option highlight
    // If a user selects the AI suggested option again, it should still be highlighted.
    // If they select something else, the highlight for the OLD ai suggestion remains, but no new temp highlight.
    this.checkAndHighlightDuplicateTargets();
    this.updateDownloadButtonsState();
  }

  private applyAISuggestionVisuals(
    row: MappingTableRow,
    suggestionType: 'header' | 'value' | 'triplet',
    suggestedTargetValue: string // This is the actual value for the select (could be N_A_MAP_VALUE)
  ) {
    row.selectedTarget = suggestedTargetValue;
    row.aiSuggestedTargetValue = suggestedTargetValue; // Store what AI actually suggested
    row.aiSuggestionType = suggestionType;
    row.isAiSuggestedTemporarily = true;

    const timeoutId = setTimeout(() => {
      row.isAiSuggestedTemporarily = false;
      this.cdr.detectChanges(); // Ensure view updates after timeout
    }, 3000);
    this.suggestionTimeouts.push(timeoutId);
    this.cdr.detectChanges();
  }

  async handleSuggestMappings(): Promise<void> {
    if (!this.isSourceUploaded || !this.isTargetSchemaProvided) {
      this.updateStatus('Source CSV must be uploaded and Target Schema must be loaded from OData first.', true);
      return;
    }
    if (!this.genAI) {
      this.updateStatus('AI service is not initialized. Check API Key.', true);
      return;
    }

    this.isSuggesting = true;
    this.suggestMappingsButtonDisabled = true;
    const originalButtonText = this.suggestButtonText;

    const totalPhases = this.isTripletKnowledgeBaseUploaded ? 2 : 1;
    let currentLogicalPhase = 0; // 0 for Triplet (if active), 1 for Header

    const updateSpinner = (phaseType: string) => {
      let displayPhase = currentLogicalPhase;
      if (this.isTripletKnowledgeBaseUploaded) {
        displayPhase += 1; // User sees 1-indexed phases
      } else {
        // If only header phase, it's phase 1 of 1
        displayPhase = 1;
      }
      this.suggestButtonText = `Thinking (${displayPhase}/${totalPhases}: ${phaseType})...`;
      this.updateStatus(`AI is thinking (Phase ${displayPhase}/${totalPhases}: ${phaseType})...`, false);
      this.cdr.detectChanges();
    };

    const alreadyUsedTargets = new Set<string>();
    // Pre-populate with existing manual selections if any
    this.mappingTableRows.forEach(row => {
        if (row.selectedTarget && row.selectedTarget !== this.N_A_MAP_VALUE && row.selectedTarget !== "") {
            alreadyUsedTargets.add(row.selectedTarget);
        }
    });


    // Phase 0: Triplet Knowledge Base
    if (this.isTripletKnowledgeBaseUploaded) {
      currentLogicalPhase = 0; // Corresponds to "Phase 1" for user
      updateSpinner("Triplet Knowledge");
      this.mappingTableRows.forEach(row => {
        if (row.selectedTarget === "" || row.selectedTarget === this.N_A_MAP_VALUE) { // Only if not manually mapped or already N/A
          const tripletEntry = this.tripletKnowledgeBase.find(entry => entry.anchor === row.sourceHeader);
          if (tripletEntry && tripletEntry.positive) {
            const suggestedTripletTarget = tripletEntry.positive;
            if (suggestedTripletTarget === "N/A" || suggestedTripletTarget === this.N_A_MAP_VALUE) {
              this.applyAISuggestionVisuals(row, 'triplet', this.N_A_MAP_VALUE);
              // N/A doesn't consume a target slot.
            } else if (this.targetSchemaColumns.includes(suggestedTripletTarget) && !alreadyUsedTargets.has(suggestedTripletTarget)) {
              this.applyAISuggestionVisuals(row, 'triplet', suggestedTripletTarget);
              alreadyUsedTargets.add(suggestedTripletTarget);
            }
          }
        }
      });
      currentLogicalPhase = 1; // Advance logical phase to Header
    } else {
      currentLogicalPhase = 0; // If no triplets, Header is the first logical phase (maps to "Phase 1" for user)
    }

    // Phase 1 (or currentLogicalPhase for spinner): Header-based AI
    updateSpinner("Header-based");
    const unmappedSourceHeadersForAI = this.mappingTableRows
        .filter(row => row.selectedTarget === "" || row.selectedTarget === this.N_A_MAP_VALUE)
        .map(row => row.sourceHeader);

    const availableTargetColsForAIHeader = this.targetSchemaColumns.filter(tc => !alreadyUsedTargets.has(tc));

    if (unmappedSourceHeadersForAI.length > 0 && availableTargetColsForAIHeader.length > 0 && this.genAI) {
      const headerPrompt = `
            You are a CSV column mapping assistant.
            Given a list of source CSV column headers and a list of available target schema column headers, suggest the best target column for each source column.
            Source CSV Headers to map: ${unmappedSourceHeadersForAI.join(', ')}
            Available Target Schema Headers: ${availableTargetColsForAIHeader.join(', ')}
            If no good match is found for a source column, or if the best match is already used by a higher-confidence mapping, suggest "N/A" for the current source column.
            Respond with a JSON object where keys are the source CSV headers and values are the suggested target schema headers (or "N/A").
            Each target column should be used at most once from the 'Available Target Schema Headers' provided.
            Example response: {"Source Column A": "Target Column X", "Source Column B": "N/A", "Source Column C": "Target Column Y"}
        `;
      try {
      // // NEW (Corrected)
      // const model = this.genAI.getGenerativeModel({
      //     model: "gemini-pro", // or "gemini-1.5-flash-latest"
      //     generationConfig: { responseMimeType: "application/json" }
      // });
      // const result = await model.generateContent({
      //     contents: [{ role: "user", parts: [{ text: headerPrompt }] }],
      // });

      
        const response = await this.genAI.models.generateContent({
            model: "gemini-2.5-flash-preview-04-17",
            contents:  [{ role: "user", parts: [{ text: headerPrompt }] }],
          });
        let jsonStr = typeof response.text === 'string' ? response.text.trim() : '';
        // console.log("Header AI Raw Response:", jsonStr);
        // Basic cleanup if ```json ... ``` is present
        const fenceRegex = /^```(\w*)?\s*\n?(.*?)\n?\s*```$/s;
        const matchJson = jsonStr.match(fenceRegex);
        if (matchJson && matchJson[2]) { jsonStr = matchJson[2].trim(); }

        const headerSuggestions: Record<string, string> = JSON.parse(jsonStr);

        unmappedSourceHeadersForAI.forEach(header => {
          const rowToUpdate = this.mappingTableRows.find(r => r.sourceHeader === header);
          if (rowToUpdate && (rowToUpdate.selectedTarget === "" || rowToUpdate.selectedTarget === this.N_A_MAP_VALUE)) {
            const suggestedTarget = headerSuggestions[header];
            if (suggestedTarget) {
              if (availableTargetColsForAIHeader.includes(suggestedTarget) && !alreadyUsedTargets.has(suggestedTarget)) {
                this.applyAISuggestionVisuals(rowToUpdate, 'header', suggestedTarget);
                alreadyUsedTargets.add(suggestedTarget);
              } else if (suggestedTarget.toUpperCase() === "N/A") {
                this.applyAISuggestionVisuals(rowToUpdate, 'header', this.N_A_MAP_VALUE);
              }
            }
          }
        });
      } catch (error) {
        console.error("Error during header-based AI suggestion:", error);
        const displayPhaseForError = this.isTripletKnowledgeBaseUploaded ? 2 : 1;
        this.updateStatus(`Error during Phase ${displayPhaseForError} (Header-based) AI suggestion. Check console.`, true);
      }
    }
    // currentPhase++; // No longer need to increment a shared currentPhase for value-based

    /*
    // Phase 2 (or currentPhase): Value-based AI
    // updateSpinner("Value-based"); // This would need adjustment if re-enabled
    if (this.genAI) {
        for (let i = 0; i < this.mappingTableRows.length; i++) {
            const row = this.mappingTableRows[i];
            if (row.selectedTarget === "" || row.selectedTarget === this.N_A_MAP_VALUE) {
                // let displayPhaseForValue = this.isTripletKnowledgeBaseUploaded ? 3 : 2;
                // this.updateStatus(`AI is thinking (Phase ${displayPhaseForValue}/${totalPhases}: Value-based for '${row.sourceHeader}')...`, false);
                // this.cdr.detectChanges();

                const availableTargetColsForValuePhase = this.targetSchemaColumns.filter(tc => !alreadyUsedTargets.has(tc));
                if (availableTargetColsForValuePhase.length === 0) continue;

                const sourceHeaderIndex = this.sourceCsvHeaders.indexOf(row.sourceHeader);
                if (sourceHeaderIndex === -1) continue;

                const sampleValues = this.sourceCsvSampleData.map(dataRow => dataRow[sourceHeaderIndex]).filter(Boolean).slice(0, 5);
                if (sampleValues.length === 0) continue;

                const exampleTargetValues: Record<string, string[]> = {};
                 availableTargetColsForValuePhase.forEach(tc => {
                    if (smat_columns_values[tc]) { exampleTargetValues[tc] = smat_columns_values[tc].slice(0,3); }
                });
                const exampleValuesString = Object.keys(exampleTargetValues).length > 0 ?
                    `\nConsider these example values for some target columns: ${JSON.stringify(exampleTargetValues)}` : "";

                const valuePrompt = `
                    You are a CSV column mapping assistant.
                    A source column named "${row.sourceHeader}" has sample values: [${sampleValues.join(', ')}].
                    Suggest the best matching target column from these available target schema columns: ${availableTargetColsForValuePhase.join(', ')}.
                    ${exampleValuesString}
                    If no good match is found, or if the best match is already used, respond "N/A".
                    Respond with only the name of the single best target schema column or "N/A".
                `;
                try {
                    // const model = this.genAI.getGenerativeModel({ model: "gemini-pro" });
                    // const result = await model.generateContent({ contents: [{ role: "user", parts: [{ text: valuePrompt }] }] });
                    // const response = result.response;
                      const response = await this.genAI.models.generateContent({
                        model: "gemini-2.5-flash-preview-04-17",
                        contents:  [{ role: "user", parts: [{ text: valuePrompt }] }],
                      });
                    let jsonStr = typeof response.text === 'string' ? response.text.trim() : '';
                    let suggestedTargetVal = jsonStr.replace(/^"|"$/g, '');

                    if (availableTargetColsForValuePhase.includes(suggestedTargetVal) && !alreadyUsedTargets.has(suggestedTargetVal)) {
                        this.applyAISuggestionVisuals(row, 'value', suggestedTargetVal);
                        alreadyUsedTargets.add(suggestedTargetVal);
                    } else if (suggestedTargetVal.toUpperCase() === "N/A" && row.selectedTarget === "") {
                         this.applyAISuggestionVisuals(row, 'value', this.N_A_MAP_VALUE);
                    }
                } catch (error) {
                    console.error(`Error during value-based AI suggestion for ${row.sourceHeader}:`, error);
                    // let displayPhaseForError = this.isTripletKnowledgeBaseUploaded ? 3 : 2;
                    // this.updateStatus(`Error for '${row.sourceHeader}' (Phase ${displayPhaseForError}). Check console.`, true);
                }
            }
        }
    }
    */

    this.updateStatus(`AI suggestions complete (all ${totalPhases} phase(s) attempted).`, false);
    this.isSuggesting = false;
    this.suggestMappingsButtonDisabled = false;
    this.suggestButtonText = originalButtonText;
    this.checkAndHighlightDuplicateTargets();
    this.updateDownloadButtonsState();
    this.cdr.detectChanges();
  }

  private escapeCsvCell(cellData: string | null | undefined): string {
    if (cellData === null || cellData === undefined) { return ""; }
    const strData = String(cellData);
    if (strData.includes(',') || strData.includes('\n') || strData.includes('"')) {
      return `"${strData.replace(/"/g, '""')}"`;
    }
    return strData;
  }

  handleDownloadTripletCsv(): void {
    if (!this.isSourceUploaded) {
      this.updateStatus('Source CSV not uploaded. Cannot generate triplet data.', true);
      return;
    }

    const tripletData: string[][] = [];
    const csvHeaders = ['anchor', 'positive', 'negative'];
    tripletData.push(csvHeaders);

    let aiSuggestionsFoundAndProcessed = false;

    this.mappingTableRows.forEach(row => {
      if (row.sourceHeader && row.aiSuggestedTargetValue) { // AI made a suggestion for this row
        aiSuggestionsFoundAndProcessed = true;
        const userFinalSelection = row.selectedTarget;
        const anchor = row.sourceHeader;
        let positive: string;
        let negative: string;

        if (userFinalSelection !== "" && userFinalSelection !== row.aiSuggestedTargetValue) {
          positive = userFinalSelection;
          negative = row.aiSuggestedTargetValue;
        } else {
          positive = row.aiSuggestedTargetValue;
          negative = ""; // No differing choice to record as negative
        }
        tripletData.push([this.escapeCsvCell(anchor), this.escapeCsvCell(positive), this.escapeCsvCell(negative)]);
      }
    });

    if (!aiSuggestionsFoundAndProcessed) {
      this.updateStatus('No AI suggestions were recorded or processed to generate triplet data. Please run AI suggestions.', false);
      return;
    }
    if (tripletData.length <= 1) {
      this.updateStatus('No triplet data generated. This might happen if AI suggestions were not made or not interacted with.', false);
      return;
    }

    this.downloadCsv(tripletData, "triplet_loss.csv");
    this.updateStatus('Triplet Loss CSV downloaded.', false);
  }

  handleDownloadMappedDataCsv(): void {
    if (!this.isSourceUploaded || this.sourceCsvSampleData.length === 0) {
      this.updateStatus('Source CSV not uploaded or no sample data available.', true);
      return;
    }

    const currentMappings = this.getSelectedTargetMappings();
    const outputTargetHeaders: string[] = [];
    const mappedTargetToSource: Record<string, string> = {}; // targetHeader -> sourceHeader

    this.sourceCsvHeaders.forEach(sourceHeader => {
      const targetHeader = currentMappings[sourceHeader];
      if (targetHeader && targetHeader !== this.N_A_MAP_VALUE && targetHeader !== "") {
        if (!mappedTargetToSource[targetHeader]) { // Ensure unique target headers in output
          outputTargetHeaders.push(targetHeader);
          mappedTargetToSource[targetHeader] = sourceHeader;
        }
        // If targetHeader is already mapped, the first source column mapped to it takes precedence.
        // This addresses potential duplicates if not caught by checkAndHighlightDuplicateTargets (though it should be).
      }
    });

    if (outputTargetHeaders.length === 0) {
      this.updateStatus('No valid column mappings found. Please map columns before downloading.', false);
      return;
    }

    const mappedData: string[][] = [];
    mappedData.push(outputTargetHeaders.map(h => this.escapeCsvCell(h)));

    this.sourceCsvSampleData.forEach(sourceRow => {
      const outputRow: string[] = [];
      outputTargetHeaders.forEach(targetHeader => {
        const originalSourceHeaderForThisTarget = mappedTargetToSource[targetHeader];
        const sourceHeaderIndex = this.sourceCsvHeaders.indexOf(originalSourceHeaderForThisTarget);

        if (sourceHeaderIndex !== -1 && sourceRow[sourceHeaderIndex] !== undefined) {
          outputRow.push(this.escapeCsvCell(sourceRow[sourceHeaderIndex]));
        } else {
          outputRow.push("");
        }
      });
      mappedData.push(outputRow);
    });

    if (mappedData.length <= 1) {
      this.updateStatus('No data to download based on current mappings.', false);
      return;
    }
    this.downloadCsv(mappedData, "mapped_data.csv");
    this.updateStatus('Mapped Data CSV downloaded.', false);
  }

  private downloadCsv(data: string[][], filename: string): void {
    const csvContent = data.map(row => row.join(',')).join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    if (link.download !== undefined) {
      const url = URL.createObjectURL(blob);
      link.setAttribute("href", url);
      link.setAttribute("download", filename);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } else {
      this.updateStatus('CSV download not supported by your browser.', true);
    }
  }
}