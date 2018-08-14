package cmd

import (
	"context"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/golang/protobuf/ptypes/duration"
	"github.com/linkerd/linkerd2/controller/api/util"
	pb "github.com/linkerd/linkerd2/controller/gen/public"
	"github.com/linkerd/linkerd2/pkg/addr"
	runewidth "github.com/mattn/go-runewidth"
	termbox "github.com/nsf/termbox-go"
	log "github.com/sirupsen/logrus"
	"github.com/spf13/cobra"
)

type topOptions struct {
	namespace   string
	toResource  string
	toNamespace string
	maxRps      float32
	scheme      string
	method      string
	authority   string
	path        string
}

type request struct {
	event   *pb.TapEvent
	reqInit *pb.TapEvent_Http_RequestInit
	rspInit *pb.TapEvent_Http_ResponseInit
	rspEnd  *pb.TapEvent_Http_ResponseEnd
}

type tableRow struct {
	by          string
	source      string
	destination string
	count       int
	best        duration.Duration
	worst       duration.Duration
	last        duration.Duration
	successes   int
	failures    int
}

const headerHeight = 3

var (
	columnNames  = []string{"Source", "Destination", "Path", "Count", "Best", "Worst", "Last", "Success Rate"}
	columnWidths = []int{23, 23, 55, 6, 6, 6, 6, 3}
	done         = make(chan struct{})
)

func newTopOptions() *tapOptions {
	return &tapOptions{
		namespace:   "default",
		toResource:  "",
		toNamespace: "",
		maxRps:      1.0,
		scheme:      "",
		method:      "",
		authority:   "",
		path:        "",
	}
}

func newCmdTop() *cobra.Command {
	options := newTopOptions()

	cmd := &cobra.Command{
		Use:   "top [flags] (RESOURCE)",
		Short: "Display sorted information about live traffic",
		Long: `Display sorted information about live traffic.

  The RESOURCE argument specifies the target resource(s) to view traffic for:
  (TYPE [NAME] | TYPE/NAME)

  Examples:
  * deploy
  * deploy/my-deploy
  * deploy my-deploy
  * ns/my-ns

  Valid resource types include:

  * deployments
  * namespaces
  * pods
  * replicationcontrollers
  * services (only supported as a "--to" resource)`,
		Example: `  # display traffic for the web deployment in the default namespace
  linkerd top deploy/web

  # display traffic for the web-dlbvj pod in the default namespace
  linkerd top pod/web-dlbvj`,
		Args:      cobra.RangeArgs(1, 2),
		ValidArgs: util.ValidTargets,
		RunE: func(cmd *cobra.Command, args []string) error {
			requestParams := util.TapRequestParams{
				Resource:    strings.Join(args, "/"),
				Namespace:   options.namespace,
				ToResource:  options.toResource,
				ToNamespace: options.toNamespace,
				MaxRps:      options.maxRps,
				Scheme:      options.scheme,
				Method:      options.method,
				Authority:   options.authority,
				Path:        options.path,
			}

			req, err := util.BuildTapByResourceRequest(requestParams)
			if err != nil {
				return err
			}

			client, err := newPublicAPIClient()
			if err != nil {
				return err
			}

			return getTrafficByResourceFromAPI(os.Stdout, client, req)
		},
	}

	cmd.PersistentFlags().StringVarP(&options.namespace, "namespace", "n", options.namespace,
		"Namespace of the specified resource")
	cmd.PersistentFlags().StringVar(&options.toResource, "to", options.toResource,
		"Display requests to this resource")
	cmd.PersistentFlags().StringVar(&options.toNamespace, "to-namespace", options.toNamespace,
		"Sets the namespace used to lookup the \"--to\" resource; by default the current \"--namespace\" is used")
	cmd.PersistentFlags().Float32Var(&options.maxRps, "max-rps", options.maxRps,
		"Maximum requests per second to tap.")
	cmd.PersistentFlags().StringVar(&options.scheme, "scheme", options.scheme,
		"Display requests with this scheme")
	cmd.PersistentFlags().StringVar(&options.method, "method", options.method,
		"Display requests with this HTTP method")
	cmd.PersistentFlags().StringVar(&options.authority, "authority", options.authority,
		"Display requests with this :authority")
	cmd.PersistentFlags().StringVar(&options.path, "path", options.path,
		"Display requests with paths that start with this prefix")

	return cmd
}

func getTrafficByResourceFromAPI(w io.Writer, client pb.ApiClient, req *pb.TapByResourceRequest) error {

	rsp, err := client.TapByResource(context.Background(), req)
	if err != nil {
		return err
	}

	err = termbox.Init()
	if err != nil {
		return err
	}
	defer termbox.Close()

	requestCh := make(chan request, 100)

	go recvEvents(rsp, requestCh)
	go pollInput()

	renderTable(requestCh)

	return nil
}

func recvEvents(tapClient pb.Api_TapByResourceClient, requestCh chan request) {
	outstandingRequests := make(map[pb.TapEvent_Http_StreamId]request)
	for {
		event, err := tapClient.Recv()
		if err == io.EOF {
			log.Error("Tap stream terminated")
			close(done)
			return
		}
		if err != nil {
			log.Error(err.Error())
			close(done)
			return
		}

		switch ev := event.GetHttp().GetEvent().(type) {
		case *pb.TapEvent_Http_RequestInit_:
			id := *ev.RequestInit.GetId()
			outstandingRequests[id] = request{
				event:   event,
				reqInit: ev.RequestInit,
			}

		case *pb.TapEvent_Http_ResponseInit_:
			id := *ev.ResponseInit.GetId()
			if req, ok := outstandingRequests[id]; ok {
				req.rspInit = ev.ResponseInit
			} else {
				log.Warn("Got ResponseInit for unknown stream: %d:%d", id.GetBase(), id.GetStream())
			}

		case *pb.TapEvent_Http_ResponseEnd_:
			id := *ev.ResponseEnd.GetId()
			if req, ok := outstandingRequests[id]; ok {
				req.rspEnd = ev.ResponseEnd
				requestCh <- req
			} else {
				log.Warn("Got ResponseEnd for unknown stream: %d:%d", id.GetBase(), id.GetStream())
			}
		}
	}
}

func pollInput() {
	for {
		switch ev := termbox.PollEvent(); ev.Type {
		case termbox.EventKey:
			if ev.Ch == 'q' {
				close(done)
				return
			}
		}
	}
}

func renderTable(requestCh chan request) {
	ticker := time.NewTicker(100 * time.Millisecond)
	var table []tableRow

	for {
		select {
		case <-done:
			return
		case req := <-requestCh:
			tableInsert(&table, req)
		case _ = <-ticker.C:
			termbox.Clear(termbox.ColorDefault, termbox.ColorDefault)
			renderHeaders()
			renderTableBody(table)
			termbox.Flush()
		}
	}
}

func tableInsert(table *[]tableRow, req request) {

	by := req.reqInit.GetPath()
	source := stripPort(addr.PublicAddressToString(req.event.GetSource()))
	destination := stripPort(addr.PublicAddressToString(req.event.GetDestination()))
	if pod := req.event.DestinationMeta.Labels["pod"]; pod != "" {
		destination = pod
	}
	latency := *req.rspEnd.GetSinceRequestInit()
	success := req.rspInit.GetHttpStatus() < 500
	if success {
		switch eos := req.rspEnd.GetEos().GetEnd().(type) {
		case *pb.Eos_GrpcStatusCode:
			success = eos.GrpcStatusCode == 0

		case *pb.Eos_ResetErrorCode:
			success = false
		}
	}

	found := false
	for i, row := range *table {
		if row.by == by && row.source == source && row.destination == destination {
			(*table)[i].count++
			if latency.Nanos < row.best.Nanos {
				(*table)[i].best = latency
			}
			if latency.Nanos > row.worst.Nanos {
				(*table)[i].worst = latency
			}
			(*table)[i].last = latency
			if success {
				(*table)[i].successes++
			} else {
				(*table)[i].failures++
			}
			found = true
		}
	}

	if !found {
		successes := 0
		failures := 0
		if success {
			successes++
		} else {
			failures++
		}
		row := tableRow{
			by:          by,
			source:      source,
			destination: destination,
			count:       1,
			best:        latency,
			worst:       latency,
			last:        latency,
			successes:   successes,
			failures:    failures,
		}
		*table = append(*table, row)
	}
}

func stripPort(address string) string {
	return strings.Split(address, ":")[0]
}

func renderHeaders() {
	tbprint(0, 0, "(press q to quit)")
	x := 0
	for i, header := range columnNames {
		width := columnWidths[i]
		padded := fmt.Sprintf("%-"+strconv.Itoa(width)+"s ", header)
		tbprintBold(x, 2, padded)
		x += width + 1
	}
}

func renderTableBody(table []tableRow) {
	sort.SliceStable(table, func(i, j int) bool {
		return table[i].count > table[j].count
	})
	for i, row := range table {
		x := 0
		tbprint(x, i+headerHeight, row.source)
		x += columnWidths[0] + 1
		tbprint(x, i+headerHeight, row.destination)
		x += columnWidths[1] + 1
		tbprint(x, i+headerHeight, row.by)
		x += columnWidths[2] + 1
		tbprint(x, i+headerHeight, strconv.Itoa(row.count))
		x += columnWidths[3] + 1
		tbprint(x, i+headerHeight, formatDuration(row.best))
		x += columnWidths[4] + 1
		tbprint(x, i+headerHeight, formatDuration(row.worst))
		x += columnWidths[5] + 1
		tbprint(x, i+headerHeight, formatDuration(row.last))
		x += columnWidths[6] + 1
		successRate := fmt.Sprintf("%.2f%%", 100.0*float32(row.successes)/float32(row.successes+row.failures))
		tbprint(x, i+headerHeight, successRate)
	}
}

func tbprint(x, y int, msg string) {
	for _, c := range msg {
		termbox.SetCell(x, y, c, termbox.ColorDefault, termbox.ColorDefault)
		x += runewidth.RuneWidth(c)
	}
}

func tbprintBold(x, y int, msg string) {
	for _, c := range msg {
		termbox.SetCell(x, y, c, termbox.AttrBold, termbox.ColorDefault)
		x += runewidth.RuneWidth(c)
	}
}

func formatDuration(d duration.Duration) string {
	if d.Nanos < 1000000 {
		micros := d.Nanos / 1000
		return fmt.Sprintf("%dµs", micros)
	}
	if d.Nanos < 1000000000 {
		millis := d.Nanos / 1000000
		return fmt.Sprintf("%dms", millis)
	}
	secs := d.Nanos / 1000000000
	return fmt.Sprintf("%ds", secs)
}