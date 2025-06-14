import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { CsvMapperComponent } from './csv-mapper.component';

export const ROUTES: Routes = [
  {
    path: '',
    component: CsvMapperComponent,
  },
];

@NgModule({
  imports: [RouterModule.forChild(ROUTES)],
  exports: [RouterModule],
})
export class CSVMapperRoutesModule {}
