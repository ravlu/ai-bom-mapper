import { HttpClient } from '@angular/common/http';
import { Inject, NgModule } from '@angular/core';
import { Router, RouterModule, Routes } from '@angular/router';
import { from, of } from 'rxjs';
import { catchError, switchMap, take, tap } from 'rxjs/operators';

import { environment } from '../environments/environment';

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
  ],
  providers: [],
  exports: [RouterModule],
})
export class AppRoutingModule {
  public constructor(private router: Router) {}
}
