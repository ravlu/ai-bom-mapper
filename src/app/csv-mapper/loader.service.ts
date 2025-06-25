import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { map, tap, concatMap } from 'rxjs/operators';
import * as uuid from 'uuid';


interface UploadResponse {
  UploadId: string;
}

interface SdaObjectResponse {
  value: { OBID: string }[];
}

interface SdaObjectCreateResponse {
  OBID: string;
}


@Injectable({
  providedIn: 'root'
})
export class LoaderService {


  private baseUrl = `http://localhost:810/api/v2`;

  constructor(private http: HttpClient) { }


  private getAuthToken(): Observable<string> {
  return of("");
    // const headers = new HttpHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' });
    // const body = new HttpParams()
    //   .set('grant_type', 'client_credentials')
    //   .set('client_id', environment.clientId)
    //   .set('client_secret', environment.clientSecret)
    //   .set('scope', 'ingr.api');

    // return this.http.post<TokenResponse>(this.tokenUrl, body.toString(), { headers }).pipe(
    //   tap(response => localStorage.setItem('okta_access_token', response.access_token)),
    //   map(response => response.access_token)
    // );
  }

  /**
   * Main method to orchestrate the entire workflow.
   * @param file The CSV file to upload.
   */
  runFullWorkflow(file: File): Observable<any> {
    let fileUploadId: string;
    let classificationObid: string;
    let loaderObid: string;

    // The workflow is a chain of RxJS operators, ensuring sequential execution.
    return this.getAuthToken().pipe(
      // Step 2 & 3: Upload File (Resume and Commit)
      concatMap(() => this._uploadFile(file)),
      tap(uploadId => fileUploadId = uploadId),

      // Step 4: Make Upload Available
      concatMap(() => this._makeUploadAvailable(fileUploadId)),

      // Step 5: Fetch Loader Classification OBID
      concatMap(() => this._fetchClassificationObid()),
      tap(obid => classificationObid = obid),

      // Step 6: Create the Loader Job
      concatMap(() => this._createLoaderJob(classificationObid)),
      tap(obid => loaderObid = obid),

      // Step 7: Attach CSV to Loader
      concatMap(() => this._attachCsvToLoader(file.name, fileUploadId, loaderObid)),

      // Step 8: Attach Workflow to Loader
      concatMap(() => this._attachWorkflowToLoader(loaderObid)),

      // Step 9: Poll for Job Completion and then Cleanup
      //concatMap(() => this._pollJobStatusAndCleanup(loaderObid)),
    );
  }

  // Private helper methods for each step in the workflow

  private _uploadFile(file: File): Observable<string> {
    const formData = new FormData();
    formData.append('file', file, file.name);

    // Part 1: Resume
    return this.http.post<UploadResponse>(`${this.baseUrl}/FileMgmt/UploadFile?type=resume&part=1`, formData).pipe(
      map(res => res.UploadId),
      // Part 2: Commit
      concatMap(uploadId =>
        this.http.post(`${this.baseUrl}/FileMgmt/UploadFile?type=commit&UploadId=${uploadId}`, formData).pipe(
          map(() => uploadId) // Pass the uploadId to the next step
        )
      )
    );
  }

  private _makeUploadAvailable(uploadId: string): Observable<any> {
    const body = { Filename: uploadId };
    return this.http.post(`${this.baseUrl}/FileMgmt/MakeUploadAvailable`, body);
  }

  private _fetchClassificationObid(): Observable<string> {
    const headers = new HttpHeaders({ 'Accept': 'application/vnd.intergraph.data+json' });
    const url = `${this.baseUrl}/SDA/Objects?$filter=contains(Interfaces,'ISDALoaderClass') and contains(UID, 'LDRC_Load_BoM_LineItem')&$select=OBID`;
    return this.http.get<SdaObjectResponse>(url, { headers }).pipe(
      map(res => res.value[0].OBID)
    );
  }

  private _createLoaderJob(classificationObid: string): Observable<string> {
    const jobName = `job-${uuid.v4()}`; // Generate a unique name like JMeter's ${__UUID}
    const headers = new HttpHeaders({ 'Accept': 'application/vnd.intergraph.data+json' });
    headers.set('X-Ingr-TenantId', '1');  
    headers.set('X-Ingr-OrgId', '5377fd8c-2461-40fa-bda2-f733d6936019');  // Assuming these are required headers
    const body = {
      "Class": "SDALoader",
      "Name": jobName,
      "Description": "Angular/TypeScript",
      "SDVLoaderSuppressENS": "False",
      "SPFPrimaryClassification_21@odata.bind": [
        `${this.baseUrl}/SDA/Objects('${classificationObid}')`
      ]
    };
    return this.http.post<SdaObjectCreateResponse>(`${this.baseUrl}/SDA/Objects`, body, { headers }).pipe(
      map(res => res.OBID)
    );
  }

  private _attachCsvToLoader(filename: string, uploadId: string, targetObid: string): Observable<any> {
    const url = `${this.baseUrl}/FileMgmt/Upload('${uploadId}')/Intergraph.SPF.Server.API.Model.Attach`;
    const body = {
      ClientFilePath: filename,
      TargetObjectOBID: targetObid,
      DeleteScannedFile: false,
      FileClass: "SPFDesignFile"
    };
    // JMeter shows GET but it has a body, which is non-standard.
    // It's very likely this should be a POST request. Let's assume POST.
    return this.http.post(url, body);
  }

  private _attachWorkflowToLoader(loaderObid: string): Observable<any> {
    const url = `${this.baseUrl}/SDA/AttachToDefaultWorkflow`;
    const body = {
      ObjectOBID: loaderObid,
      WorkflowNameOrUID: "HEX DTO Loader Workflow"
    };
    return this.http.post(url, body);
  }

  // private _pollJobStatusAndCleanup(loaderObid: string): Observable<any> {
  //   const statusUrl = `${this.baseUrl}/Objects?$filter=Class eq 'SDALoader' and OBID eq '${loaderObid}' and SPFActiveWorkflowCount ne null&$count=true&$select=OBID`;

  //   // Poll every 30 seconds (30000 ms)
  //   return timer(5000, 30000).pipe(
  //       // Switch to the HTTP call to get the status
  //       switchMap(() => this.http.get<OdataCountResponse>(statusUrl)),
  //       // Keep polling as long as the job count is not 0
  //       takeWhile(res => res['@odata.count'] !== 0, true), // `true` includes the last emission (when count is 0)
  //       // Once the loop breaks (because count is 0), take the final result
  //       last(),
  //       // Switch to the delete operation
  //       switchMap(() => this._deleteLoaderJob(loaderObid))
  //   );
  // }

  // private _deleteLoaderJob(loaderObid: string): Observable<any> {
  //   console.log(`Job ${loaderObid} completed. Deleting...`);
  //   const deleteUrl = `${this.baseUrl}/SDA/Objects('${loaderObid}')`;
  //   return this.http.delete(deleteUrl);
  // }
}
