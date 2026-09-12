/*
 * A printer that prints to the viewer.
 *
 * FreeRDP redirects printing through a driver plugin, and the one it ships
 * hands the job to CUPS -- a queue, attached to paper, on the machine running
 * the client. That is the wrong end of this connection: the person who pressed
 * print is in a browser, and what they want back is a file.
 *
 * So this driver announces a single printer and, instead of spooling, hands
 * the job up to the bridge. What arrives is PostScript, because the printer is
 * announced with the name of a PostScript driver and Windows renders to what
 * it believes it is talking to -- the same trick FreeRDP's own CUPS backend
 * uses, and Guacamole before it.
 *
 * Loaded by name with dlopen, exactly like the audio device beside it. The
 * bridge's functions are weak so that this object loaded into anything else
 * discards the job rather than failing to resolve a symbol.
 */

#include <stdlib.h>
#include <string.h>

#include <freerdp/client/printer.h>

__attribute__((weak)) void termix_print_write(unsigned job, const void* data, size_t size);
__attribute__((weak)) void termix_print_close(unsigned job);

/*
 * The name Windows sees, and the driver it believes it is talking to.
 *
 * The driver name is the load-bearing half. Windows picks a rendering path
 * from it, and "MS Publisher Imagesetter" is a PostScript driver present on
 * every Windows install -- so the job arrives as PostScript rather than as
 * XPS, which would need .NET on this side to mean anything.
 */
#define TERMIX_PRINTER_NAME "Termix"
#define TERMIX_PRINTER_DRIVER "MS Publisher Imagesetter"

typedef struct
{
	rdpPrintJob job;
} termixPrintJob;

typedef struct
{
	rdpPrinter printer;
	/* One job at a time is all RDP asks of a printer here, but the id is kept
	 * so that FindPrintJob can answer truthfully rather than by assuming. */
	termixPrintJob* current;
} termixPrinter;

typedef struct
{
	rdpPrinterDriver driver;
	size_t references;
	termixPrinter* printer;
} termixPrinterDriver;

static termixPrinterDriver* g_driver = NULL;

static UINT termix_job_write(rdpPrintJob* job, const BYTE* data, size_t size)
{
	if (!job || !data || size == 0)
		return CHANNEL_RC_OK;

	if (termix_print_write)
		termix_print_write(job->id, data, size);
	return CHANNEL_RC_OK;
}

static void termix_job_close(rdpPrintJob* job)
{
	if (!job)
		return;

	if (termix_print_close)
		termix_print_close(job->id);

	termixPrinter* printer = (termixPrinter*)job->printer;
	if (printer && printer->current == (termixPrintJob*)job)
		printer->current = NULL;

	free(job);
}

static rdpPrintJob* termix_create_job(rdpPrinter* printer, UINT32 id)
{
	termixPrinter* self = (termixPrinter*)printer;
	if (!self)
		return NULL;

	termixPrintJob* job = (termixPrintJob*)calloc(1, sizeof(termixPrintJob));
	if (!job)
		return NULL;

	job->job.id = id;
	job->job.printer = printer;
	job->job.Write = termix_job_write;
	job->job.Close = termix_job_close;

	self->current = job;
	return &job->job;
}

static rdpPrintJob* termix_find_job(rdpPrinter* printer, UINT32 id)
{
	termixPrinter* self = (termixPrinter*)printer;
	if (!self || !self->current || self->current->job.id != id)
		return NULL;
	return &self->current->job;
}

/* The printer outlives every job, so its reference count is a formality kept
 * because the channel calls into it. */
static void termix_printer_ref(rdpPrinter* printer)
{
	(void)printer;
}

static termixPrinter* termix_printer_new(rdpPrinterDriver* driver, const char* name,
                                         const char* driverName)
{
	termixPrinter* printer = (termixPrinter*)calloc(1, sizeof(termixPrinter));
	if (!printer)
		return NULL;

	printer->printer.id = 1;
	printer->printer.name = _strdup(name ? name : TERMIX_PRINTER_NAME);
	printer->printer.driver = _strdup(driverName ? driverName : TERMIX_PRINTER_DRIVER);
	printer->printer.is_default = TRUE;
	printer->printer.backend = driver;
	printer->printer.CreatePrintJob = termix_create_job;
	printer->printer.FindPrintJob = termix_find_job;
	printer->printer.AddRef = termix_printer_ref;
	printer->printer.ReleaseRef = termix_printer_ref;

	if (!printer->printer.name || !printer->printer.driver)
	{
		free(printer->printer.name);
		free(printer->printer.driver);
		free(printer);
		return NULL;
	}
	return printer;
}

static rdpPrinter** termix_enum_printers(rdpPrinterDriver* driver)
{
	termixPrinterDriver* self = (termixPrinterDriver*)driver;
	if (!self)
		return NULL;

	/* Null terminated, which is how the channel knows where the list ends. */
	rdpPrinter** printers = (rdpPrinter**)calloc(2, sizeof(rdpPrinter*));
	if (!printers)
		return NULL;

	if (!self->printer)
		self->printer = termix_printer_new(driver, NULL, NULL);
	printers[0] = self->printer ? &self->printer->printer : NULL;
	return printers;
}

static void termix_release_enum_printers(rdpPrinter** printers)
{
	/* Only the array is ours; the printer in it is the driver's and outlives
	 * this call. */
	free(printers);
}

static rdpPrinter* termix_get_printer(rdpPrinterDriver* driver, const char* name,
                                      const char* driverName, BOOL isDefault)
{
	termixPrinterDriver* self = (termixPrinterDriver*)driver;
	(void)isDefault;
	if (!self)
		return NULL;

	if (!self->printer)
		self->printer = termix_printer_new(driver, name, driverName);
	return self->printer ? &self->printer->printer : NULL;
}

static void termix_driver_add_ref(rdpPrinterDriver* driver)
{
	termixPrinterDriver* self = (termixPrinterDriver*)driver;
	if (self)
		self->references++;
}

static void termix_driver_release_ref(rdpPrinterDriver* driver)
{
	termixPrinterDriver* self = (termixPrinterDriver*)driver;
	if (!self || --self->references > 0)
		return;

	if (self->printer)
	{
		free(self->printer->printer.name);
		free(self->printer->printer.driver);
		free(self->printer);
	}
	free(self);
	if (g_driver == self)
		g_driver = NULL;
}

UINT freerdp_printer_client_subsystem_entry(void* arg)
{
	rdpPrinterDriver** result = (rdpPrinterDriver**)arg;
	if (!result)
		return ERROR_INVALID_PARAMETER;

	if (!g_driver)
	{
		g_driver = (termixPrinterDriver*)calloc(1, sizeof(termixPrinterDriver));
		if (!g_driver)
			return ERROR_OUTOFMEMORY;

		g_driver->driver.EnumPrinters = termix_enum_printers;
		g_driver->driver.ReleaseEnumPrinters = termix_release_enum_printers;
		g_driver->driver.GetPrinter = termix_get_printer;
		g_driver->driver.AddRef = termix_driver_add_ref;
		g_driver->driver.ReleaseRef = termix_driver_release_ref;
	}

	g_driver->driver.AddRef(&g_driver->driver);
	*result = &g_driver->driver;
	return CHANNEL_RC_OK;
}
