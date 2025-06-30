// src/app/csv-mapper/csv-mapper.component.ts
import { Component, OnInit, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { GoogleGenAI } from "@google/genai";
import { environment } from '../../environments/environment';
import { LoaderService } from './loader.service';

const STANDARD_COLUMNS: string[] = ['Line Item ID', 'Tag Number', 'Short Description', 'Quantity', 'Unit', 'Commodity Code', 'Size1', 'Specification Code'];

// // Predefined example values for potential SMAT columns.
// const smat_columns_values: Record<string, string[]> = {
//     // Example:
//     // "Status": ["Open", "Closed", "Pending"],
//     // "Priority": ["High", "Medium", "Low"]
// };

interface MappingTableRow {
    sourceHeader: string;
    selectedTarget: string;
    aiSuggestedTargetValue?: string; // The value AI suggested (could be N_A or a column name)
    aiSuggestionType?: 'header' | 'value' | 'triplet' | null;
    isAiSuggestedTemporarily?: boolean; // For temporary class on row/select
    isDuplicate?: boolean;
    // aiSuggestedOptionValue?: string; // The value of the option that AI suggested (for persistent option highlight)
}

interface TargetSchemaColumn {
  DisplayName: string;
  Synonyms: string[] | null;
  Antonyms: string[] | null;
  UID: string;
  OBID: string;
}

@Component({
  selector: 'app-csv-mapper',
  templateUrl: './csv-mapper.component.html',
  styleUrls: ['./csv-mapper.component.css']
})
export class CsvMapperComponent implements OnInit, OnDestroy {
  readonly CREATE_NEW_PROPERTY_VALUE = "__CREATE_NEW_PROPERTY__";
  bominterfaceId = '0197A2700DE949A1858A4E3AEECB5459';
  private odataUrl = `http://localhost:810/api/v2/SDA/Objects('${this.bominterfaceId}')/Exposes_12?$select=DisplayName,Synonyms,Antonyms,UID,OBID`;
  private readonly SDA_OBJECTS_BASE_URL = "http://localhost:810/api/v2/SDA/Objects"; // For PATCH
  private createPropertyUrl = `http://localhost:810/api/v2/SDA/CreateBOMInvertedCSVMapping`;
  sourceCsvHeaders: string[] = [];
  sourceCsvSampleData: string[][] = []; // Only first 10 rows of actual data
  targetSchemaColumns: string[] = []; // This will store only DisplayNames for the dropdown
  private targetSchemaData: TargetSchemaColumn[] = []; // To store full data including synonyms/antonyms
  tripletKnowledgeBase: Array<{ anchor: string, positive: string, negative: string }> = [];

  isSourceUploaded = false;
  isTargetSchemaProvided = false; // This will be set by OData fetch
  isTripletKnowledgeBaseUploaded = false; // Can be true either by OData or file upload

  readonly N_A_MAP_VALUE = "__N/A_MAPPING__";

  statusMessageText = 'Please upload a Source CSV and a Target Schema CSV to begin.';
  isStatusError = false;

  mappingTableRows: MappingTableRow[] = [];

  // Button states & UI
  suggestMappingsButtonDisabled = true;
  // downloadTripletCsvButtonVisible = false; // Removed
  // downloadTripletCsvButtonDisabled = true; // Removed
  downloadMappedDataButtonVisible = false;
  downloadMappedDataButtonDisabled = true;
  aiSuggestionControlsVisible = false;

  isSuggesting = false;
  suggestButtonText = 'Suggest Mappings with AI';
  private suggestionTimeouts: any[] = []; // To clear timeouts on component destroy

  // Create New Property Modal State
  isCreatePropertyModalVisible: boolean = false;
  newPropertyName: string = '';
  currentMappingRowForCreate: MappingTableRow | null = null;
  allowCreateNewProperty: boolean = false;
  createPropertyError: string = '';


  private genAI: GoogleGenAI | null = null;

  constructor(private cdr: ChangeDetectorRef, private http: HttpClient, private loaderService: LoaderService) {
    
    if (!environment.apiKey) {
      console.error("API_KEY environment variable not set for Gemini API.");
      this.updateStatus('Configuration error: API Key is missing. Cannot contact AI service.', true);
    } else {
      this.genAI = new GoogleGenAI({apiKey: environment.apiKey});
      
    }
  
  }

  ngOnInit(): void {
  this.http
    .get("http://localhost:810/api/v2/SDA/Objects?$filter=UID eq 'IBOMLineItem' and class eq 'InterfaceDef'&$select=OBID")
    .subscribe({
      next: (response: any) => {
        console.log("OBID Response:", response);
        this.bominterfaceId = response.value?.[0]?.OBID || this.bominterfaceId;
        // Update the odataUrl with the potentially new bominterfaceId
        this.odataUrl = `http://localhost:810/api/v2/SDA/Objects('${this.bominterfaceId}')/Exposes_12?$select=DisplayName,Synonyms,Antonyms,UID,OBID`;
        console.log("Fetched bominterfaceId:", this.bominterfaceId, "New OData URL for Exposes_12:", this.odataUrl);
        this.fetchTargetSchemaFromOData(); // This will now also trigger triplet fetching
        this.checkIfReadyForMappingAndSuggestions();
      },
      error: (err) => {
        console.error("Error fetching OBID:", err);
        this.updateStatus("Error fetching OBID. Check console for details.", true);
        // Still attempt to load target schema with fallback/default OBID
        // this.fetchTargetSchemaFromOData(); // This will now also trigger triplet fetching
        // this.checkIfReadyForMappingAndSuggestions();
      }
    });
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
      const response: any = await this.http.get<Array<TargetSchemaColumn>>(this.odataUrl).toPromise();
      if (response && response.value && Array.isArray(response.value)) {
        this.targetSchemaData = response.value.map((item: any) => ({
          DisplayName: item.DisplayName,
          Synonyms: item.Synonyms ? item.Synonyms.split(';').map((s: string) => s.trim()) : null,
          Antonyms: item.Antonyms ? item.Antonyms.split(';').map((a: string) => a.trim()) : null,
          UID: item.UID, // Make sure UID is present in the response and item
          OBID: item.OBID // Make sure OBID is present
        })).filter((item: TargetSchemaColumn) => item.DisplayName && item.UID && item.OBID); // Ensure OBID is also present

        this.targetSchemaColumns = this.targetSchemaData.map(item => item.DisplayName);

        if (this.targetSchemaColumns.length > 0) {
          this.isTargetSchemaProvided = true;
          this.updateStatus(`Target schema loaded from OData: ${this.targetSchemaColumns.length} columns.`, false);
          this.fetchTripletKnowledgeFromOData(); // Call to populate triplets
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

  fetchTripletKnowledgeFromOData(): void {
    if (!this.isTargetSchemaProvided || this.targetSchemaData.length === 0) {
      return;
    }

    const triplets: Array<{ anchor: string, positive: string, negative: string }> = [];
    this.targetSchemaData.forEach(item => {
      if (item.DisplayName) {
        if (item.Synonyms && item.Synonyms.length > 0) {
          item.Synonyms.forEach(synonym => {
            if (synonym) { // Ensure synonym is not empty
              triplets.push({ anchor: item.DisplayName, positive: synonym, negative: "" });
            }
          });
        }
        if (item.Antonyms && item.Antonyms.length > 0) {
          item.Antonyms.forEach(antonym => {
            if (antonym) { // Ensure antonym is not empty
              // If synonyms also existed, we might create new entries or append to existing ones.
              // For simplicity, creating new entries. Could be optimized.
              triplets.push({ anchor: item.DisplayName, positive: "", negative: antonym });
            }
          });
        }
        // If only DisplayName exists, and no synonyms or antonyms, we don't add a triplet.
        // Or, we could add { anchor: item.DisplayName, positive: item.DisplayName, negative: ""} if needed.
        // Current user story implies synonyms/antonyms are the source for positive/negative.
      }
    });

    if (triplets.length > 0) {
      // If a CSV was uploaded, we might want to merge or prioritize.
      // For now, OData triplets will overwrite if fetched after a CSV upload (which shouldn't happen with current flow)
      // or append if this is called multiple times (which it shouldn't).
      // Let's assume this is the primary source if no CSV is uploaded.
      if (!this.isTripletKnowledgeBaseUploaded) { // Only set if not already set by CSV
        this.tripletKnowledgeBase = triplets;
        this.isTripletKnowledgeBaseUploaded = true;
        this.updateStatus(`Triplet knowledge automatically derived from OData: ${this.tripletKnowledgeBase.length} relationships.`, false);
      } else {
        // Potentially merge or inform user about multiple sources.
        // For now, if CSV was uploaded, we prefer that.
        console.log("Triplet CSV already uploaded. OData triplets were fetched but not applied to avoid overwrite. Consider merging logic if needed.");
      }
    }
    this.checkIfReadyForMappingAndSuggestions();
  }

  updateDownloadButtonsState(): void {
    // Triplet Data Button - Removed
    // if (this.isSourceUploaded && this.isTargetSchemaProvided) {
    //   this.downloadTripletCsvButtonVisible = true;
    //   this.downloadTripletCsvButtonDisabled = false; // Enable if suggestions were made
    // } else {
    //   this.downloadTripletCsvButtonVisible = false;
    //   this.downloadTripletCsvButtonDisabled = true;
    // }

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
      let readyMessage = 'Source CSV loaded. Target Schema and Triplet Knowledge automatically loaded from OData.';
      // if (this.isTripletKnowledgeBaseUploaded) { // This is now part of the above message or handled if CSV was uploaded first
      //   readyMessage += ' Triplet Knowledge CSV also loaded.';
      // }
      readyMessage += ' You can now manually map columns or use AI suggestions.';
      // Check if triplet was loaded by CSV, if so, amend message.
      // This check needs to be more robust if we allow OData triplets AND CSV triplets to merge.
      // For now, if isTripletKnowledgeBaseUploaded is true, it could be from OData or CSV.
      // The fetchTripletKnowledgeFromOData has logic to not overwrite CSV-loaded data.
      // So the generic "Triplet knowledge available" is fine.
      if (this.isTripletKnowledgeBaseUploaded && !this.tripletKnowledgeBase.some(t => t.anchor)) {
          // This case implies isTripletKnowledgeBaseUploaded was true BUT OData didn't find any,
          // and no CSV was uploaded. This state should ideally not happen with current logic.
          // Or, if a CSV was uploaded but it was empty/invalid.
      }


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
    const userSelectedTarget = changedRow.selectedTarget;
    const aiSuggestedTarget = changedRow.aiSuggestedTargetValue; // What AI last suggested for this row
    const sourceHeader = changedRow.sourceHeader;

    // Priority 1: Handle "Create New Property" selection
    if (userSelectedTarget === this.CREATE_NEW_PROPERTY_VALUE) {
      this.currentMappingRowForCreate = changedRow;
      this.newPropertyName = '';
      this.createPropertyError = '';
      this.isCreatePropertyModalVisible = true;
      // Feedback for a newly created property will be handled when it's actually created and assigned.
      // For now, we don't want to revert the dropdown immediately if _updatePropertyFeedback is async.
      // The closeCreatePropertyModal(true) handles reverting if cancelled.
      return;
    }

    // Apply new feedback logic
    // Synonym Logic: If user selected a valid target AND it's different from the source header itself.
    if (userSelectedTarget && userSelectedTarget !== this.N_A_MAP_VALUE && userSelectedTarget !== "") {
      if (sourceHeader.toLowerCase() !== userSelectedTarget.toLowerCase()) {
        this._updatePropertyFeedback(userSelectedTarget, sourceHeader, true);
      }
    }

    // Antonym Logic: If AI had made a valid suggestion AND user changed it to something else (could be another property or N/A).
    if (aiSuggestedTarget && aiSuggestedTarget !== this.N_A_MAP_VALUE && aiSuggestedTarget !== "") {
      if (userSelectedTarget !== aiSuggestedTarget) {
        this._updatePropertyFeedback(aiSuggestedTarget, sourceHeader, false);
      }
    }

    // General UI updates after any mapping change
    changedRow.isAiSuggestedTemporarily = false; // User manually interacted, remove temporary AI highlight
    this.checkAndHighlightDuplicateTargets();
    this.updateDownloadButtonsState();
    // Note: aiSuggestedTargetValue remains on the row. If AI runs again, it will be overwritten.
    // If user changes mapping multiple times without AI re-running, aiSuggestedTargetValue still refers to the *last AI suggestion*.
  }

  onCreatePropertyNameChange(): void {
    if (!this.newPropertyName.trim()) {
      this.createPropertyError = 'Property name cannot be empty.';
      return;
    }
    const isDuplicate = this.targetSchemaColumns.some(
      col => col.toLowerCase() === this.newPropertyName.trim().toLowerCase()
    );
    if (isDuplicate) {
      this.createPropertyError = `Property "${this.newPropertyName.trim()}" already exists.`;
    } else {
      this.createPropertyError = ''; // Clear error if valid
    }
  }


  closeCreatePropertyModal(revertSelection: boolean = true): void {
    this.isCreatePropertyModalVisible = false;
    if (this.currentMappingRowForCreate && revertSelection) {
      // Revert the selection in the dropdown if user cancelled
      this.currentMappingRowForCreate.selectedTarget = ""; // Or a stored previous value
      // Manually trigger change detection if needed, or ensure ngModelChange handles it
      this.checkAndHighlightDuplicateTargets(); // Re-validate after reverting
      this.updateDownloadButtonsState();
    }
    this.currentMappingRowForCreate = null;
    this.newPropertyName = '';
    this.createPropertyError = '';
  }

  async handleCreateProperty(): Promise<void> {
    if (!this.newPropertyName || this.createPropertyError) {
      // Should be disabled, but as a safeguard
      this.createPropertyError = this.createPropertyError || 'Property name is invalid.';
      return;
    }

    const propertyToCreate = this.newPropertyName.trim();

    try {
      this.updateStatus(`Creating new property "${propertyToCreate}"...`, false);
      // Assuming API expects {"propertyDef": "name"}
      await this.http.post(this.createPropertyUrl, { propertyDef: propertyToCreate }).toPromise();

      this.updateStatus(`Successfully created property "${propertyToCreate}".`, false);

      // Add to target schema lists
      this.targetSchemaColumns.push(propertyToCreate);
      this.targetSchemaData.push({
        DisplayName: propertyToCreate,
        Synonyms: null,
        Antonyms: null,
        UID: '', // Placeholder, backend creates actual UID.
        OBID: '' // Placeholder, backend creates actual OBID. Cannot be used for PATCH.
      });

      if (this.currentMappingRowForCreate) {
        this.currentMappingRowForCreate.selectedTarget = propertyToCreate;
        // Highlight it as if AI suggested it or a different class? For now, just select.
        this.currentMappingRowForCreate.isAiSuggestedTemporarily = false;
      }

      this.closeCreatePropertyModal(false); // Close modal, don't revert selection
      this.checkAndHighlightDuplicateTargets();
      this.updateDownloadButtonsState();
      this.cdr.detectChanges();

    } catch (error: any) {
      console.error('Error creating new property:', error);
      const errorMsg = error.error?.message || error.message || 'An unknown error occurred.';
      this.createPropertyError = `Failed to create property: ${errorMsg}`;
      this.updateStatus(`Error creating property "${propertyToCreate}". ${errorMsg}`, true);
    }
  }

  private async _updatePropertyFeedback(propertyName: string, feedbackSourceHeader: string, isPositive: boolean): Promise<void> {
    if (!propertyName || !feedbackSourceHeader) {
      return; // Essential info missing
    }

    const targetSchemaEntry = this.targetSchemaData.find(entry => entry.DisplayName === propertyName);
    if (!targetSchemaEntry || !targetSchemaEntry.OBID) {
      console.warn(`Cannot update feedback for property "${propertyName}": OBID not found or missing. Feedback source: "${feedbackSourceHeader}"`);
      this.updateStatus(`Cannot save feedback for "${propertyName}": essential identifier (OBID) is missing.`, true);
      return;
    }

    const patchUrl = `${this.SDA_OBJECTS_BASE_URL}('${targetSchemaEntry.OBID}')`;
    let currentSynonyms = '';
    let currentAntonyms = '';

    try {
       const headers = new HttpHeaders({ 'Accept': 'application/vnd.intergraph.data+json' });
       headers.set('X-Ingr-TenantId', '1');  
    headers.set('X-Ingr-OrgId', '5377fd8c-2461-40fa-bda2-f733d6936019'); 
     console.log('headers', headers);
      // Ensure we have the correct headers for the request
      // Fetch current Synonyms and Antonyms first
      const currentObjectState: any = await this.http.get(`${patchUrl}?$select=Synonyms,Antonyms`, { headers:headers }).toPromise();
      currentSynonyms = currentObjectState.Synonyms || '';
      currentAntonyms = currentObjectState.Antonyms || '';

      let synonymsArray = currentSynonyms ? currentSynonyms.split(';').map(s => s.trim()) : [];
      let antonymsArray = currentAntonyms ? currentAntonyms.split(';').map(a => a.trim()) : [];
      const feedbackLower = feedbackSourceHeader.toLowerCase();
      let changed = false;
      const payload: { Synonyms?: string, Antonyms?: string } = {};

      if (isPositive) {
        // Add to Synonyms, remove from Antonyms if present
        if (antonymsArray.map(a => a.toLowerCase()).includes(feedbackLower)) {
          antonymsArray = antonymsArray.filter(a => a.toLowerCase() !== feedbackLower);
          payload.Antonyms = antonymsArray.join(';');
          changed = true;
        }
        if (!synonymsArray.map(s => s.toLowerCase()).includes(feedbackLower)) {
          synonymsArray.push(feedbackSourceHeader);
          payload.Synonyms = synonymsArray.join(';');
          changed = true;
        }
      } else { // isNegative (Antonym)
        // Add to Antonyms, remove from Synonyms if present
        if (synonymsArray.map(s => s.toLowerCase()).includes(feedbackLower)) {
          synonymsArray = synonymsArray.filter(s => s.toLowerCase() !== feedbackLower);
          payload.Synonyms = synonymsArray.join(';');
          changed = true;
        }
        if (!antonymsArray.map(a => a.toLowerCase()).includes(feedbackLower)) {
          antonymsArray.push(feedbackSourceHeader);
          payload.Antonyms = antonymsArray.join(';');
          changed = true;
        }
      }

      if (changed) {
            const headers = new HttpHeaders({ 'Accept': 'application/vnd.intergraph.data+json' });
       headers.set('X-Ingr-TenantId', '1');  
    headers.set('X-Ingr-OrgId', '5377fd8c-2461-40fa-bda2-f733d6936019'); 
     console.log('headers', headers);
        await this.http.patch(patchUrl, payload,{headers:headers}).toPromise();
        this.updateStatus(`Feedback for "${feedbackSourceHeader}" on "${propertyName}" saved.`, false);
        // Optionally update local cache of synonyms/antonyms for targetSchemaEntry
        if (payload.Synonyms !== undefined) targetSchemaEntry.Synonyms = payload.Synonyms.split(';');
        if (payload.Antonyms !== undefined) targetSchemaEntry.Antonyms = payload.Antonyms.split(';');
      } else {
        this.updateStatus(`Feedback for "${feedbackSourceHeader}" on "${propertyName}" already consistent.`, false);
      }

    } catch (error: any) {
      console.error(`Error updating feedback for property "${propertyName}" (OBID: ${targetSchemaEntry.OBID}):`, error);
      const errorMsg = error.error?.message || error.message || 'An unknown error occurred during feedback update.';
      this.updateStatus(`Failed to save feedback for "${propertyName}": ${errorMsg}`, true);
    }
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

    // Triplet knowledge is now potentially available from OData even if isTripletKnowledgeBaseUploaded (by file) is false
    const hasAnyTripletKnowledge = this.tripletKnowledgeBase.length > 0;

    const totalPhases = hasAnyTripletKnowledge ? 2 : 1;
    let currentLogicalPhase = 0; // 0 for Triplet (if active), 1 for Header

    const updateSpinner = (phaseType: string) => {
      let displayPhase = currentLogicalPhase;
      if (hasAnyTripletKnowledge) {
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
    if (hasAnyTripletKnowledge) {
      currentLogicalPhase = 0; // Corresponds to "Phase 1" for user
      updateSpinner("Triplet Knowledge");
      this.mappingTableRows.forEach(row => {
        if (row.selectedTarget === "" || row.selectedTarget === this.N_A_MAP_VALUE) { // Only if not manually mapped or already N/A
          // Find triplet entries where the 'positive' (synonym) matches the current sourceHeader
          const matchingTripletEntries = this.tripletKnowledgeBase.filter(
            entry => entry.positive && entry.positive.toLowerCase() === row.sourceHeader.toLowerCase() && entry.anchor
          );

          for (const tripletEntry of matchingTripletEntries) {
            const suggestedTargetAnchor = tripletEntry.anchor; // This is the target DisplayName

            // Check if this anchor is a valid target column and hasn't been used yet
            if (this.targetSchemaColumns.includes(suggestedTargetAnchor) && !alreadyUsedTargets.has(suggestedTargetAnchor)) {
              this.applyAISuggestionVisuals(row, 'triplet', suggestedTargetAnchor);
              alreadyUsedTargets.add(suggestedTargetAnchor);
              break; // Found a valid suggestion for this row, move to the next row
            }
            // If the suggestedTargetAnchor is "N/A" (though unlikely for an anchor from synonyms), handle it.
            // Or if N_A_MAP_VALUE is explicitly set as a positive, treat it.
            else if (suggestedTargetAnchor === this.N_A_MAP_VALUE || tripletEntry.positive === this.N_A_MAP_VALUE) {
                 this.applyAISuggestionVisuals(row, 'triplet', this.N_A_MAP_VALUE);
                 break;
            }
          }
          // Negatives are not directly used for suggestions here, but for training data generation for the AI model.
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
    this.allowCreateNewProperty = true; // Enable create new property option
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

  // handleDownloadTripletCsv(): void { // REMOVED
  // }

 handleDownloadMappedDataCsv(): void {
    if (!this.isSourceUploaded || this.sourceCsvSampleData.length === 0) {
      this.updateStatus('Source CSV not uploaded or no sample data available.', true);
      return;
    }

   this.getSelectedTargetMappings(); // Existing: SourceHeader -> TargetHeader
    const mappedTargetToSource: Record<string, string> = {}; // TargetHeader -> SourceHeader
    const allUserMappedTargetHeaders: string[] = []; // All target headers the user actually mapped

    this.mappingTableRows.forEach(row => {
      if (row.selectedTarget && row.selectedTarget !== this.N_A_MAP_VALUE && row.selectedTarget !== "") {
        if (!allUserMappedTargetHeaders.includes(row.selectedTarget)) {
          allUserMappedTargetHeaders.push(row.selectedTarget);
        }
        mappedTargetToSource[row.selectedTarget] = row.sourceHeader;
      }
    });

    if (allUserMappedTargetHeaders.length === 0) {
      this.updateStatus('No valid column mappings found. Please map columns before uploading.', false);
      return;
    }

    const standardCsvData: string[][] = [];
    const invertedCsvData: string[][] = [];

    standardCsvData.push([...STANDARD_COLUMNS]);
    invertedCsvData.push(['Line Item ID', 'Property_Name', 'Property_Value', 'Property_Value_UoM']);

    let lineItemIdSourceHeader: string | undefined = undefined;
    const lineItemIdMapping = this.mappingTableRows.find(row => row.selectedTarget === 'Line Item ID');
    if (lineItemIdMapping && lineItemIdMapping.sourceHeader) {
      lineItemIdSourceHeader = lineItemIdMapping.sourceHeader;
    } else {
      console.warn("Line Item ID is not mapped. It will be blank in the inverted CSV.");
    }

    const finalStandardHeaders = STANDARD_COLUMNS.filter(sc => allUserMappedTargetHeaders.includes(sc));
    const nonStandardTargetHeaders = allUserMappedTargetHeaders.filter(h => !STANDARD_COLUMNS.includes(h));

    this.sourceCsvSampleData.forEach(sourceRow => {
      let lineItemIdValue: string = "";
      if (lineItemIdSourceHeader) {
        const sourceHeaderIndex = this.sourceCsvHeaders.indexOf(lineItemIdSourceHeader);
        if (sourceHeaderIndex !== -1 && sourceRow[sourceHeaderIndex] !== undefined) {
          lineItemIdValue = this.escapeCsvCell(sourceRow[sourceHeaderIndex]);
        }
      }

      const outputStandardRow: string[] = [];
      STANDARD_COLUMNS.forEach(stdHeader => {
        if (finalStandardHeaders.includes(stdHeader)) {
          const originalSourceHeader = mappedTargetToSource[stdHeader];
          if (originalSourceHeader) {
            const sourceHeaderIndex = this.sourceCsvHeaders.indexOf(originalSourceHeader);
            if (sourceHeaderIndex !== -1 && sourceRow[sourceHeaderIndex] !== undefined) {
              outputStandardRow.push(this.escapeCsvCell(sourceRow[sourceHeaderIndex]));
            } else {
              outputStandardRow.push("");
            }
          } else {
            outputStandardRow.push("");
          }
        } else {
          outputStandardRow.push("");
        }
      });
      standardCsvData.push(outputStandardRow);

      nonStandardTargetHeaders.forEach(nonStdHeader => {
        const originalSourceHeader = mappedTargetToSource[nonStdHeader]; // nonStdHeader is DisplayName
        if (originalSourceHeader) {
          const sourceHeaderIndex = this.sourceCsvHeaders.indexOf(originalSourceHeader);
          if (sourceHeaderIndex !== -1 && sourceRow[sourceHeaderIndex] !== undefined) {
            const propertyValue = this.escapeCsvCell(sourceRow[sourceHeaderIndex]);
            if (propertyValue !== "") {
              const targetSchemaEntry = this.targetSchemaData.find(tsd => tsd.DisplayName === nonStdHeader);
              let propertyNameForCsv = nonStdHeader; // Default to DisplayName
              if(!propertyNameForCsv.startsWith("BOM")) {
              propertyNameForCsv = propertyNameForCsv.replace(/[^a-zA-Z0-9_]/g, ''); // Replace non-alphanumeric with underscore
              propertyNameForCsv= "BOM"+ propertyNameForCsv; // Ensure it starts with "BOM"
              }
              if (targetSchemaEntry && targetSchemaEntry.UID && targetSchemaEntry.UID.trim() !== "") {
                propertyNameForCsv = targetSchemaEntry.UID;
              } else if (targetSchemaEntry) {
                // Entry exists but UID is missing, empty, or whitespace
                console.warn(`UID is missing or empty for DisplayName: '${nonStdHeader}'. Using DisplayName as fallback for Property_Name in inverted CSV.`);
              } else {
                // No entry found for this DisplayName at all (should be rare if mappings are correct)
                console.warn(`No target schema entry found for DisplayName: '${nonStdHeader}'. Using DisplayName as fallback for Property_Name in inverted CSV.`);
              }
              invertedCsvData.push([lineItemIdValue, this.escapeCsvCell(propertyNameForCsv), propertyValue, ""]);
            }
          }
        }
      });
    });


    let statusMessages: string[] = [];

   const createFileObject = (fileData: string[][], filename: string): File | null => {
      if (fileData.length <= 1) { // Only headers or empty
        statusMessages.push(`${filename} had no data to upload.`);
        return null;
      }
      const csvContent = fileData.map(row => row.join(',')).join('\r\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
       return new File([blob], filename, { type: 'text/csv;charset=utf-8;' });
    };
  
     const standardFile = createFileObject(standardCsvData, "standard_mapped_data.csv");
    const invertedFile = createFileObject(invertedCsvData, "inverted_mapped_data.csv");

    const uploadStandard = () => {
      if (standardFile) {
        this.updateStatus(`Uploading ${standardFile.name}...`, false);
        this.loaderService.runFullWorkflow(standardFile).subscribe({
          next: () => {
            statusMessages.push(`${standardFile.name} uploaded successfully.`);
            this.updateStatus(statusMessages.join(' '), false);
            uploadInverted(); // Proceed to inverted upload
          },
          error: (err) => {
            console.error(`Error uploading ${standardFile.name}:`, err);
            statusMessages.push(`Error uploading ${standardFile.name}. Check console. Inverted file will not be uploaded.`);
            this.updateStatus(statusMessages.join(' '), true);
            // Do not proceed to upload inverted file
            finalizeUploadProcess();
          }
        });
      } else {
        // If standard file is null (no data), attempt to upload inverted if it exists
        setTimeout(() => {
             uploadInverted();
        }, 180000);
     
      }
    };
     const uploadInverted = () => {
      if (invertedFile) {
        this.updateStatus(`Uploading ${invertedFile.name}...`, false);
        this.loaderService.runFullWorkflow(invertedFile).subscribe({
          next: () => {
            statusMessages.push(`${invertedFile.name} uploaded successfully.`);
            this.updateStatus(statusMessages.join(' '), false);
            finalizeUploadProcess();
          },
          error: (err) => {
            console.error(`Error uploading ${invertedFile.name}:`, err);
            statusMessages.push(`Error uploading ${invertedFile.name}. Check console.`);
            this.updateStatus(statusMessages.join(' '), true);
            finalizeUploadProcess();
          }
        });
      } else {
        finalizeUploadProcess();
      }
    };
     const finalizeUploadProcess = () => {
        if (lineItemIdSourceHeader === undefined && (standardFile || invertedFile)) {
            statusMessages.push("Note: 'Line Item ID' was not mapped; it will be blank in the Inverted CSV if it was uploaded.");
        }
        if (statusMessages.length > 0) {
            const isError = statusMessages.some(msg => msg.toLowerCase().includes("error"));
            this.updateStatus(statusMessages.join(' '), isError);
        } else if (!standardFile && !invertedFile) {
             this.updateStatus('No data to upload for Standard or Inverted CSVs based on current mappings.', false);
        }
    };
  if (standardFile || invertedFile) {
        uploadStandard();
    } else {
        // Neither file had data
        finalizeUploadProcess();
    }
    if (lineItemIdSourceHeader === undefined) {
        statusMessages.push("Note: 'Line Item ID' was not mapped; it will be blank in the Inverted CSV.");
    }

    if (statusMessages.length > 0 && !(standardCsvData.length > 1 || invertedCsvData.length > 1)) {
        this.updateStatus(statusMessages.join(' '), false);
    } else if (!(standardCsvData.length > 1 || invertedCsvData.length > 1)) {
        this.updateStatus('No data to upload for Standard or Inverted CSVs based on current mappings.', false);
    }
  }
  

  //private downloadCsv(data: string[][], filename: string): void {
  //  const csvContent = data.map(row => row.join(',')).join('\r\n');
  //  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  //  const link = document.createElement("a");
  //  if (link.download !== undefined) {
  //    const url = URL.createObjectURL(blob);
  //    link.setAttribute("href", url);
  //    link.setAttribute("download", filename);
  //    link.style.visibility = 'hidden';
  //    document.body.appendChild(link);
  //    link.click();
  //    document.body.removeChild(link);
  //  } else {
  //    this.updateStatus('CSV download not supported by your browser.', true);
  //  }
  //}
}
