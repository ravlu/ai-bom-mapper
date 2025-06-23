//import { HttpClient } from '@angular/common/http';
import { Inject, NgModule } from '@angular/core';
import { Router, RouterModule, Routes } from '@angular/router';
import {  Observable, of } from 'rxjs';
//import { catchError, switchMap, take, tap } from 'rxjs/operators';

//import { environment } from '../environments/environment';
import { ClipperMicroAppRoutingModule } from '@sdx2-client/clipper';
import { SDxTranslateHttpLoader, MicroAppInitializationService } from '@sdx2-client/common';
import { CLIPPER_TOKEN } from '@clipper/angular';
import { ClipperApp } from '@clipper/app';
import { TranslateLoader, TranslateModule } from '@ngx-translate/core';
import { HttpClient } from '@angular/common/http';

/**
 * Defines all routes for the application and what to load when those routes are navigated to
 */
const routes: Routes = [
  {
    path: '',
    children: [
      {
        path: 'csv-column-mapper',
        // Disabling the following rules because of their implications on performance at runtime due to references being needed
        // eslint-disable-next-line @typescript-eslint/typedef
        loadChildren: () =>
          import('src/app/csv-mapper/csv-mapper.routing.module').then(
            (m) => m.CsvMapperRoutingModule
          ),
      },
    ],
  },
];

/**
 * Before the application starts read the settings file and store the results
 *
 */
@NgModule({
  imports: [
    RouterModule.forRoot(routes, {
      useHash: true,
    }),
		TranslateModule.forRoot({
			loader: {
				provide: TranslateLoader,
				useClass: SDxTranslateHttpLoader,
				deps: [HttpClient]
			}
		})
  ],
  providers: [],
  exports: [RouterModule],
})
export class AppRoutingModule extends ClipperMicroAppRoutingModule {
	public constructor(initializationService: MicroAppInitializationService, router: Router, @Inject(CLIPPER_TOKEN) clipper: ClipperApp) {
		super(initializationService, clipper, router);
	}

	protected onBeforeInitialNavigation(): Observable<boolean> {
		return of(true);
	}
}
