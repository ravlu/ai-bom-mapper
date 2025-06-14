import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CSVMapperRoutesModule } from './csv-mapper.routes';
import { CsvMapperComponent } from './csv-mapper.component';

@NgModule({
  imports: [CommonModule, FormsModule, CSVMapperRoutesModule],
  declarations: [CsvMapperComponent],
  providers: [],
})
export class CsvMapperRoutingModule {}
