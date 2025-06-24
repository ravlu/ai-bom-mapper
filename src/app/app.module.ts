// src/app/app.module.ts
import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { HTTP_INTERCEPTORS, HttpClientModule } from '@angular/common/http';

import { AppComponent } from './app.component';
import { AppRoutingModule } from './app.routing.module';
import { SDxClipperServiceModule, TokenInterceptor } from '@sdx2-client/clipper';
import { ClipperAppManager } from '@clipper/app';
import { CLIPPER_TOKEN } from '@clipper/angular';
import { SDxCoreServicesModule } from '@sdx2-client/common';


@NgModule({
  declarations: [AppComponent],
  imports: [
    BrowserModule,
    FormsModule,
    HttpClientModule,
    AppRoutingModule,
		SDxCoreServicesModule,
		SDxClipperServiceModule
  ],
  providers: [{
			provide: HTTP_INTERCEPTORS,
			useClass: TokenInterceptor,
			multi: true
		},		
		{
			provide: CLIPPER_TOKEN,
			useClass: ClipperAppManager
		}],
  bootstrap: [AppComponent],
})
export class AppModule {}